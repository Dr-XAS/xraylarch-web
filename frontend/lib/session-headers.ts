// Only the app's anonymous credential crosses the frontend/backend boundary.
// Other cookies may belong to sibling apps on the same parent domain.
const cookieName = "xraylarch_session"

export function sessionRequestHeaders(source: Headers): Headers {
  const headers = new Headers()
  const cookie = source.get("cookie")?.split(";").map(value => value.trim())
    .find(value => value.startsWith(`${cookieName}=`))
  if (cookie) headers.set("cookie", cookie)
  return headers
}

export function copySessionCookies(source: Headers, target: Headers) {
  for (const cookie of source.getSetCookie()) {
    if (cookie.startsWith(`${cookieName}=`)) target.append("set-cookie", cookie)
  }
}
