"""Bounded Materials Project REST searches and immutable CIF snapshots.

API reference: https://api.materialsproject.org/docs
The key stays in the backend environment; upstream bodies/errors are never
forwarded to the browser. Saved attachments do not depend on this service.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone

import httpx

from .errors import WebInputError
from .structure_search import formula_match_rank, parse_formula

_BASE = "https://api.materialsproject.org"
_ID = re.compile(r"^mp-(?:[1-9][0-9]{0,11}|[a-z]{8})$")
_CACHE: OrderedDict = OrderedDict()
_LOCK = threading.RLock()
_TTL = 600
_MAX_RESPONSE = 4_000_000


def _fail(message, code="materials_project_unavailable", field="provider"):
    raise WebInputError(code, message, fields=(field,),
                        recovery="Review the Materials Project search or backend API key, then retry. Attached CIFs remain available offline.")


def _key():
    key = os.environ.get("MP_API_KEY", "").strip()
    if not key:
        _fail("Materials Project search needs an API key. Set MP_API_KEY in the backend environment and restart the backend.",
              "materials_project_not_configured")
    return key


def _get(path, params):
    key = _key()
    cache_key = (hashlib.sha256(key.encode()).hexdigest(), path, tuple(sorted(params.items())))
    with _LOCK:
        cached = _CACHE.get(cache_key)
        if cached and time.monotonic() - cached[0] < _TTL:
            _CACHE.move_to_end(cache_key)
            return copy.deepcopy(cached[1])
    try:
        with httpx.Client(timeout=httpx.Timeout(20, connect=5), follow_redirects=False) as client:
            with client.stream("GET", _BASE + path, params=params, headers={"X-API-KEY": key, "Accept": "application/json"}) as response:
                if response.status_code in (401, 403):
                    _fail("Materials Project rejected the backend API key. Check MP_API_KEY and its account access.", "materials_project_auth")
                if response.status_code == 429:
                    _fail("Materials Project is limiting requests. Wait briefly before searching again.", "materials_project_rate_limit")
                if response.status_code == 404:
                    _fail("This Materials Project record is unavailable.", "materials_project_not_found")
                if response.status_code in (400, 422):
                    _fail("Materials Project could not use this search. Use a formula, chemical system, element, or MP ID.", "invalid_materials_project_query", "q")
                if response.status_code != 200:
                    _fail("Materials Project is temporarily unavailable. Try again later.")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE:
                        _fail("The Materials Project response exceeds the supported size. Refine the search.")
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError("Expected an object")
                result["_retrieved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    except WebInputError:
        raise
    except httpx.TimeoutException:
        _fail("Materials Project did not respond within the time limit. Try again.")
    except (httpx.HTTPError, ValueError):
        # Never include an upstream exception: it may contain request credentials.
        _fail("Materials Project could not be reached or returned an invalid response. Try again.")
    with _LOCK:
        _CACHE[cache_key] = (time.monotonic(), copy.deepcopy(result))
        _CACHE.move_to_end(cache_key)
        while len(_CACHE) > 128:
            _CACHE.popitem(last=False)
    return result


def _summary(document):
    ident = document.get("material_id", "")
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        _fail("Materials Project returned an invalid material identifier.")
    formula = document.get("formula_pretty")
    symmetry = document.get("symmetry") or {}
    if not isinstance(formula, str) or not formula or len(formula) > 5000 or not isinstance(symmetry, dict):
        _fail("Materials Project returned incomplete structure metadata.")
    symbol = symmetry.get("symbol")
    if symbol is None:
        symbol = ""
    if not isinstance(symbol, str) or len(symbol) > 500:
        _fail("Materials Project returned invalid symmetry metadata.")
    return dict(id=ident, provider="materials_project", mineral=formula, formula=formula,
                space_group=symbol, authors="", year=None, journal="",
                title="Materials Project DFT-relaxed structure")


def _documents(response):
    documents = response.get("data")
    if not isinstance(documents, list) or any(not isinstance(item, dict) for item in documents):
        _fail("Materials Project returned an invalid search response.")
    return documents


def search_structures(query="", element="", limit=25):
    from pymatgen.core import Element

    query = query.strip()
    params = {"_fields": "material_id,formula_pretty,symmetry", "_limit": limit + 1,
              "_skip": 0, "deprecated": "false"}
    composition = None
    try:
        if element.strip():
            params["elements"] = Element(element.strip().capitalize()).symbol
        if _ID.fullmatch(query):
            params["material_ids"] = query
        elif "-" in query:
            elements = query.split("-")
            params["chemsys"] = "-".join(sorted({Element(item).symbol for item in elements}))
        elif query:
            composition = parse_formula(query)
            if composition is None:
                raise ValueError("Invalid formula")
            # MP stores reduced formulas, including integer formulas for partial
            # occupancies (LiMn0.5Ni0.5O2 is stored as Li2MnNiO4).
            params["formula"] = composition.get_integer_formula_and_factor()[0]
        elif not element.strip():
            raise ValueError("Empty search")
    except (ValueError, TypeError, KeyError):
        _fail("Use a chemical formula (Cu2O), chemical system (Cu-O), element filter (Cu), or MP ID (mp-30).",
              "invalid_materials_project_query", "q")
    searches = [params]
    if composition is not None and len(composition.elements) > 1:
        broad = dict(params)
        del broad["formula"]
        broad["chemsys"] = "-".join(sorted(item.symbol for item in composition.elements))
        searches.append(broad)

    # The independent formula request prevents a full chemical-system page from
    # hiding the requested stoichiometry. Both pages remain bounded and cached.
    unique = {}
    limited = False
    for search in searches:
        response = _get("/materials/summary/", search)
        documents = _documents(response)
        metadata = response.get("meta")
        total = metadata.get("total_doc") if isinstance(metadata, dict) else None
        if isinstance(total, int) and total > len(documents):
            limited = True
        for document in documents:
            result = _summary(document)
            unique.setdefault(result["id"], result)
    results = list(unique.values())
    if composition is not None:
        results.sort(key=lambda result: formula_match_rank(query, result["formula"]))
    limited = limited or len(results) > limit
    results = results[:limit]
    return dict(query=query, source="Materials Project · DFT-relaxed structures", provider="materials_project",
                results=results, count=len(results), limited=limited)


def structure_details(ident):
    from pymatgen.core import Structure
    from pymatgen.io.cif import CifWriter
    from .artemis_structures import snapshot_details

    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        _fail("Use a valid Materials Project ID such as mp-30.", "invalid_materials_project_query", "ident")
    params = {"material_ids": ident, "_fields": "material_id,formula_pretty,symmetry,structure,origins",
              "_limit": 1, "deprecated": "false"}
    if ident[3:].isdigit():
        params["id_format"] = "legacy"
    response = _get("/materials/summary/", params)
    documents = _documents(response)
    if not documents:
        _fail("This Materials Project record is unavailable.", "materials_project_not_found")
    document = documents[0]
    summary = _summary(document)
    if summary["id"] != ident:
        _fail("Materials Project returned a different structure than requested.")
    try:
        structure = Structure.from_dict(document["structure"])
        if len(structure) > 500:
            _fail("This Materials Project structure exceeds the supported 500-site limit.")
        # Keep the returned cell and coordinates; do not silently refine geometry.
        cif = str(CifWriter(structure, symprec=None))
        if len(cif.encode("utf-8")) > 500_000:
            _fail("This Materials Project CIF exceeds the supported 500 KB limit.")
    except WebInputError:
        raise
    except (KeyError, ValueError, TypeError, AttributeError):
        _fail("Materials Project returned a structure that could not be converted to CIF.")
    meta = response.get("meta") or {}
    database_version = meta.get("db_version") if isinstance(meta, dict) else None
    if database_version is None:
        try:
            database_version = _get("/heartbeat", {}).get("db_version")
        except WebInputError:
            pass  # An unavailable version stays unknown; the exact CIF is retained.
    origins = document.get("origins")
    if origins is None:
        origins = []
    if not isinstance(origins, list):
        _fail("Materials Project returned invalid structure provenance.")
    task_id = next((item.get("task_id") for item in origins
                    if isinstance(item, dict) and item.get("name") == "structure"), None)
    if any(value is not None and (not isinstance(value, str) or len(value) > 100) for value in (database_version, task_id)):
        _fail("Materials Project returned invalid structure provenance.")
    provenance = dict(database_version=database_version,
                      retrieved_at=response["_retrieved_at"],
                      task_id=task_id, structure_type="dft_relaxed")
    return snapshot_details(summary | dict(cif=cif, source=f"https://materialsproject.org/materials/{ident}", provenance=provenance))
