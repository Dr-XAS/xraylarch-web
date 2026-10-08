"""Formula relevance and the MP-first, AMCSD-backed CIF search."""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from xraylarch_web import artemis_structures as structures
from xraylarch_web import materials_project as mp
from xraylarch_web.config import Settings
from xraylarch_web.errors import WebInputError
from xraylarch_web.main import create_app
from xraylarch_web.structure_search import formula_match_rank, parse_formula


@pytest.mark.parametrize("query,formula,rank", [
    ("LiMnNiO2", "Ni Li Mn O2", 0),
    ("LiMn0.5Ni0.5O2", "Li2MnNiO4", 1),
    ("LiMnNiO2", "LiMn0.5Ni0.5O2", 2),
    ("LiMnNiO2", "LiMn0.5Ni0.5Co0.1O2", 3),
    ("LiMnNiO2", "LiMnO2", 3),
    ("Ca3(PO4)2", "Ca3P2O8", 0),
    ("Li[Ni0.5Mn0.5]O2", "LiMn0.5Ni0.5O2", 0),
    ("Li{Ni0.5Mn0.5}O2", "LiMn0.5Ni0.5O2", 0),
    ("Co", "CO", 3),
    ("copper", "Cu", 3),
    ("Fe2O3", "Fe1.9O3", 2),
])
def test_formula_relevance(query, formula, rank):
    assert formula_match_rank(query, formula) == rank


@pytest.fixture
def formula_database(tmp_path, monkeypatch):
    database = tmp_path / "synthetic.db"
    with sqlite3.connect(database) as connection:
        connection.executescript("""
            CREATE TABLE minerals (id INTEGER, name TEXT);
            CREATE TABLE spacegroups (id INTEGER, hm_notation TEXT);
            CREATE TABLE publications (id INTEGER, year INTEGER, journalname TEXT);
            CREATE TABLE authors (id INTEGER, name TEXT);
            CREATE TABLE publication_authors (author_id INTEGER, publication_id INTEGER);
            CREATE TABLE cif_elements (cif_id TEXT, element TEXT);
            CREATE TABLE cif (id INTEGER, mineral_id INTEGER, spacegroup_id INTEGER,
                publication_id INTEGER, formula TEXT, pub_title TEXT,
                a TEXT, b TEXT, c TEXT, alpha TEXT, beta TEXT, gamma TEXT);
            INSERT INTO minerals VALUES (1, 'Synthetic oxide');
            INSERT INTO spacegroups VALUES (1, 'P1');
            INSERT INTO publications VALUES (1, 2026, 'Synthetic fixture');
        """)
        # The exact hit deliberately comes after the broad hits in ID order.
        formulae = {1: "Li Mn0.5 Ni0.5 O2", 2: "Li2 Mn2 Ni2 O4", 3: "Ni Li Mn O2",
                    4: "Li Mn0.5 Ni0.5 Co0.1 O2", 5: "Li Mn O2"}
        for ident, formula in formulae.items():
            connection.execute("INSERT INTO cif VALUES (?,1,1,1,?,'',3,3,3,90,90,90)", (ident, formula))
            symbols = [item.symbol for item in parse_formula(formula).elements]
            # Real AMCSD contains repeated element rows and stores IDs as text.
            connection.executemany("INSERT INTO cif_elements VALUES (?,?)",
                                   [(str(ident), symbol) for symbol in symbols + symbols[:1]])
    monkeypatch.setattr(structures, "_DATABASE", database)


def test_amcsd_formula_broadens_and_ranks_before_truncating(formula_database):
    result = structures.search_structures("LiMnNiO2", limit=2)
    assert [item["id"] for item in result["results"]] == [3, 2]
    assert result["limited"]
    result = structures.search_structures("LiMnNiO2", limit=25)
    assert [item["id"] for item in result["results"]] == [3, 2, 1]
    assert not result["limited"]
    assert structures.search_structures("LiMnNiO2", element="Co")["results"] == []
    assert structures.search_structures("1")["results"][0]["id"] == 1
    assert structures.search_structures("Synthetic oxide")["count"] == 5
    assert structures.search_structures("%_")["results"] == []


def search_result(*rows, limited=False):
    return dict(results=[dict(id=ident, formula=formula) for ident, formula in rows],
                limited=limited)


def test_combined_search_calls_mp_first_and_prioritizes_exact_across_sources(monkeypatch):
    calls = []

    def remote(*args):
        calls.append("mp")
        return search_result(("mp-1", "LiMnNiO2"), ("mp-2", "LiMn0.5Ni0.5O2"))

    def local(*args):
        calls.append("amcsd")
        return search_result((1, "LiMnNiO2"), (2, "LiMn0.5Ni0.5O2"))

    monkeypatch.setattr(mp, "search_structures", remote)
    monkeypatch.setattr(structures, "search_structures", local)
    response = structures.search_all_structures("LiMnNiO2", limit=3)
    assert calls == ["mp", "amcsd"]
    assert [item["id"] for item in response["results"]] == ["mp-1", 1, "mp-2"]
    assert [item["provider"] for item in response["results"]] == ["materials_project", "amcsd", "materials_project"]
    assert response["limited"] and response["count"] == 3 and response["warnings"] == []


@pytest.mark.parametrize("code", ["materials_project_not_configured", "materials_project_auth",
                                 "materials_project_rate_limit", "materials_project_unavailable"])
def test_mp_failure_keeps_amcsd_results_and_explains_partial_search(monkeypatch, code):
    def failed(*args):
        raise WebInputError(code, "Materials Project unavailable for this test.")

    monkeypatch.setattr(mp, "search_structures", failed)
    monkeypatch.setattr(structures, "search_structures", lambda *args: search_result((1, "Cu")))
    result = structures.search_all_structures("Cu")
    assert result["results"] == [dict(id=1, formula="Cu", provider="amcsd")]
    assert result["warnings"] == ["Materials Project unavailable for this test."]


def test_mineral_search_uses_local_without_invalid_formula_warning(monkeypatch):
    def failed(*args):
        raise WebInputError("invalid_materials_project_query", "Use a chemical formula.")

    monkeypatch.setattr(mp, "search_structures", failed)
    monkeypatch.setattr(structures, "search_structures", lambda *args: search_result((1, "Cu")))
    assert structures.search_all_structures("copper")["warnings"] == []


def test_local_failure_keeps_mp_results_but_both_failures_are_an_error(monkeypatch):
    def failed(*args):
        raise WebInputError("invalid_artemis_structure", "AMCSD database unavailable.")

    monkeypatch.setattr(structures, "search_structures", failed)
    monkeypatch.setattr(mp, "search_structures", lambda *args: search_result(("mp-30", "Cu"), limited=True))
    result = structures.search_all_structures("Cu")
    assert result["results"][0]["id"] == "mp-30"
    assert result["limited"] and result["warnings"] == ["AMCSD database unavailable."]
    monkeypatch.setattr(mp, "search_structures", failed)
    with pytest.raises(WebInputError):
        structures.search_all_structures("Cu")
    def invalid_query(*args):
        raise WebInputError("invalid_materials_project_query", "Use a chemical formula.")

    monkeypatch.setattr(mp, "search_structures", invalid_query)
    with pytest.raises(WebInputError, match="AMCSD database unavailable"):
        structures.search_all_structures("copper")


def test_http_auto_source_and_legacy_default(tmp_path, monkeypatch):
    monkeypatch.setattr(mp, "search_structures", lambda *args: search_result(("mp-30", "Cu")))
    monkeypatch.setattr(structures, "search_structures", lambda *args: search_result((1, "Cu")))
    with TestClient(create_app(Settings(data_root=tmp_path))) as client:
        response = client.get("/api/artemis/structures", params=dict(q="Cu", provider="auto"))
        assert response.status_code == 200
        assert [item["id"] for item in response.json()["results"]] == ["mp-30", 1]
        assert client.get("/api/artemis/structures", params=dict(q="Cu")).json()["results"][0]["id"] == 1
