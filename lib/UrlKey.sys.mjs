export function pageKey(url) {
  return url;
}

export function originKeys(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (!parsed.hostname) {
    return [];
  }
  const prePath = `${parsed.protocol}//${parsed.host}`;
  const bareHost = parsed.hostname.replace(/^www\./, "");
  return prePath === bareHost ? [prePath] : [prePath, bareHost];
}

export function normalizeTerm(term) {
  if (typeof term !== "string") {
    return "";
  }
  return term.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function urlVariants(url) {
  const match = /^(https?):\/\/(www\.)?(.*)$/i.exec(url);
  if (!match) {
    return [url];
  }
  const rest = match[3];
  const variants = [`https://${rest}`, `https://www.${rest}`, `http://${rest}`, `http://www.${rest}`];
  return [url, ...variants.filter((variant) => variant !== url)];
}
