/** Source-specific search controls supported by protocols.io's public search UI. */

export const PROTOCOLS_IO_SORT_VALUES = ["relevance", "date", "title", "mentions", "wfm"] as const;
export type ProtocolsIoSort = (typeof PROTOCOLS_IO_SORT_VALUES)[number];

export const PROTOCOLS_IO_ORDER_VALUES = ["asc", "desc"] as const;
export type ProtocolsIoOrder = (typeof PROTOCOLS_IO_ORDER_VALUES)[number];

export const PROTOCOLS_IO_ACCESS_VALUES = ["open_access", "springer_protocols"] as const;
export type ProtocolsIoAccess = (typeof PROTOCOLS_IO_ACCESS_VALUES)[number];

/** Exact advanced-search field keys used by protocols.io. */
export const PROTOCOLS_IO_ADVANCED_FIELDS = [
  "all",
  "all_entities.techniques",
  "all_entities.antibodies",
  "all_entities.organisms",
  "all_entities.cell_lines",
  "title",
  "authors_string",
  "orcid",
  "affiliation",
  "funders_string",
  "funder_grant",
  "abstract",
  "keywords",
  "equipment_title",
  "equipment_sku",
  "reagent_title",
  "reagent_rrid",
  "reagent_cas_number",
  "reagent_catalog_number",
] as const;
export type ProtocolsIoAdvancedField = (typeof PROTOCOLS_IO_ADVANCED_FIELDS)[number];

export interface ProtocolsIoFieldQuery {
  field: ProtocolsIoAdvancedField;
  value: string;
}

export interface ProtocolsIoSearchOptions {
  /** Advanced queries are explicit; sidebar facets belong only to simple mode. */
  mode?: "simple" | "advanced";
  openAccess?: boolean;
  springerProtocol?: boolean;
  /** Native protocols.io sort key: relevance, date, title, mentions (Impact), or wfm. */
  sortBy?: ProtocolsIoSort;
  /** Native sort direction. protocols.io defaults title to asc and the other sorts to desc. */
  order?: ProtocolsIoOrder;
  /** One-indexed result page. */
  page?: number;
  access?: ProtocolsIoAccess[];
  techniques?: string[];
  antibodies?: string[];
  organisms?: string[];
  cellLines?: string[];
  /** Convenience alias for advanced field `keywords`. Multiple tags are ANDed. */
  tags?: string[];
  /** Any protocols.io advanced-search field/value pair. */
  fields?: ProtocolsIoFieldQuery[];
  journalTitle?: string;
  articleDoi?: string;
  /** ISO date (YYYY-MM-DD); protocols.io applies publication dates only as a complete range. */
  publishedFrom?: string;
  /** ISO date (YYYY-MM-DD); protocols.io applies publication dates only as a complete range. */
  publishedTo?: string;
}

const SORT_SET = new Set<string>(PROTOCOLS_IO_SORT_VALUES);
const ORDER_SET = new Set<string>(PROTOCOLS_IO_ORDER_VALUES);
const ACCESS_SET = new Set<string>(PROTOCOLS_IO_ACCESS_VALUES);
const FIELD_SET = new Set<string>(PROTOCOLS_IO_ADVANCED_FIELDS);

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map(optionalString)
    .filter((item): item is string => Boolean(item));
  return out.length > 0 ? [...new Set(out)] : undefined;
}

/** Whitelist and normalize untrusted MCP input before it reaches URL construction. */
export function parseProtocolsIoSearchOptions(value: unknown): ProtocolsIoSearchOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("protocolsIo must be an object");
  const raw = value as Record<string, unknown>;
  validateOptions(raw);
  const sortBy = typeof raw.sortBy === "string" && SORT_SET.has(raw.sortBy)
    ? raw.sortBy as ProtocolsIoSort
    : undefined;
  const order = typeof raw.order === "string" && ORDER_SET.has(raw.order)
    ? raw.order as ProtocolsIoOrder
    : undefined;
  const access = Array.isArray(raw.access)
    ? [...new Set(raw.access.filter((item): item is ProtocolsIoAccess =>
        typeof item === "string" && ACCESS_SET.has(item)))]
    : undefined;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.flatMap((item): ProtocolsIoFieldQuery[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const entry = item as Record<string, unknown>;
        const field = typeof entry.field === "string" && FIELD_SET.has(entry.field)
          ? entry.field as ProtocolsIoAdvancedField
          : undefined;
        const fieldValue = optionalString(entry.value);
        return field && fieldValue ? [{ field, value: fieldValue }] : [];
      })
    : undefined;
  const pageValue = typeof raw.page === "number" && Number.isFinite(raw.page)
    ? Math.max(1, Math.floor(raw.page))
    : undefined;
  const techniques = stringList(raw.techniques);
  const antibodies = stringList(raw.antibodies);
  const organisms = stringList(raw.organisms);
  const cellLines = stringList(raw.cellLines);
  const tags = stringList(raw.tags);
  const journalTitle = optionalString(raw.journalTitle);
  const articleDoi = optionalString(raw.articleDoi);
  const publishedFrom = optionalString(raw.publishedFrom);
  const publishedTo = optionalString(raw.publishedTo);

  const parsed: ProtocolsIoSearchOptions = {
    ...(raw.mode ? { mode: raw.mode as "simple" | "advanced" } : {}),
    ...(typeof raw.openAccess === "boolean" ? { openAccess: raw.openAccess } : {}),
    ...(typeof raw.springerProtocol === "boolean" ? { springerProtocol: raw.springerProtocol } : {}),
    ...(sortBy ? { sortBy } : {}),
    ...(order ? { order } : {}),
    ...(pageValue ? { page: pageValue } : {}),
    ...(access ? { access } : {}),
    ...(techniques ? { techniques } : {}),
    ...(antibodies ? { antibodies } : {}),
    ...(organisms ? { organisms } : {}),
    ...(cellLines ? { cellLines } : {}),
    ...(tags ? { tags } : {}),
    ...(fields?.length ? { fields } : {}),
    ...(journalTitle ? { journalTitle } : {}),
    ...(articleDoi ? { articleDoi } : {}),
    ...(publishedFrom ? { publishedFrom } : {}),
    ...(publishedTo ? { publishedTo } : {}),
  };
  return hasProtocolsIoSearchOptions(parsed) ? parsed : undefined;
}

export const PROTOCOLS_IO_FACET_KEYS = ["access", "techniques", "antibodies", "organisms", "cellLines"] as const;
export type ProtocolsIoFacetKey = (typeof PROTOCOLS_IO_FACET_KEYS)[number];

function validateOptions(raw: Record<string, unknown>): void {
  const lists = [...PROTOCOLS_IO_FACET_KEYS, "tags"];
  const strings = ["journalTitle", "articleDoi", "publishedFrom", "publishedTo"];
  const allowed = new Set([...lists, ...strings, "mode", "sortBy", "order", "page", "fields", "openAccess", "springerProtocol"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`Unknown protocolsIo option: ${key}`);
  for (const [key, choices] of [["mode", new Set(["simple", "advanced"])], ["sortBy", SORT_SET], ["order", ORDER_SET]] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !choices.has(raw[key] as string))) throw new Error(`Invalid protocolsIo.${key}`);
  }
  if (raw.page !== undefined && (!Number.isSafeInteger(raw.page) || (raw.page as number) < 1)) throw new Error("protocolsIo.page must be a positive integer");
  for (const key of lists) {
    const list = raw[key];
    if (list !== undefined && (!Array.isArray(list) || list.some(x => typeof x !== "string" || !x.trim() || x.includes("|")))) throw new Error(`protocolsIo.${key} must be an array of nonempty values without |`);
  }
  if ((raw.access as string[] | undefined)?.some(x => !ACCESS_SET.has(x))) throw new Error("Invalid protocolsIo.access");
  for (const key of strings) if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`protocolsIo.${key} must be a string`);
  for (const key of ["openAccess", "springerProtocol"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`protocolsIo.${key} must be boolean`);
  if (raw.fields !== undefined && (!Array.isArray(raw.fields) || raw.fields.some(x => !x || typeof x !== "object" || !FIELD_SET.has(x.field) || typeof x.value !== "string" || !x.value.trim()))) throw new Error("Invalid protocolsIo.fields");
  const advanced = ["fields", "tags"].some(k => (raw[k] as unknown[] | undefined)?.length) || strings.some(k => Boolean(raw[k])) || raw.openAccess !== undefined || raw.springerProtocol !== undefined;
  if (advanced && raw.mode !== "advanced") throw new Error('Advanced fields require protocolsIo.mode="advanced"; sidebar facets are not converted automatically');
  if (raw.mode === "advanced" && PROTOCOLS_IO_FACET_KEYS.some(k => (raw[k] as unknown[] | undefined)?.length)) throw new Error("Advanced mode does not support sidebar facets; use explicit fields and openAccess/springerProtocol instead");
  if (Boolean(raw.publishedFrom) !== Boolean(raw.publishedTo)) throw new Error("Publication filtering requires both publishedFrom and publishedTo");
  for (const key of ["publishedFrom", "publishedTo"]) {
    const date = raw[key];
    if (date && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error(`Invalid ISO date: ${key}`);
  }
  if (raw.publishedFrom && raw.publishedTo && String(raw.publishedFrom) > String(raw.publishedTo)) throw new Error("publishedFrom must not follow publishedTo");
}

export function hasProtocolsIoSearchOptions(options?: ProtocolsIoSearchOptions): boolean {
  return Boolean(options && Object.keys(options).length > 0);
}

function values(options: string[] | undefined): string[] {
  return options?.map((value) => value.trim()).filter(Boolean) ?? [];
}

function addParam(params: string[], key: string, value: string | number | undefined): void {
  if (value === undefined || value === "") return;
  params.push(`${key}=${encodeURIComponent(String(value))}`);
}

/** The website defaults simple searches to Open Access; [] explicitly clears it. */
export function effectiveProtocolsIoSearchOptions(options: ProtocolsIoSearchOptions = {}): ProtocolsIoSearchOptions {
  return options.mode === "advanced" ? { ...options } : { ...options, access: options.access ?? ["open_access"] };
}

/** Query syntax sent by the website to /api/v1/search, observed 2026-10-08. */
export function protocolsIoAdvancedQuery(query: string, options: ProtocolsIoSearchOptions): string {
  validateOptions(options as Record<string, unknown>);
  const escape = (value: string): string => value.trim().replace(/([(){}\[\]^\\/])/g, "\\$1");
  const field = (key: ProtocolsIoAdvancedField, value: string): string => {
    if (key === "all") return value.trim();
    const text = escape(value);
    return key.startsWith("all_entities.")
      ? `${key}:("${text.replaceAll('"', "")}")` : `${key}:(${text})`;
  };
  const clauses = [query.trim(), ...values(options.tags).map(value => field("keywords", value)),
    ...(options.fields ?? []).map(({ field: key, value }) => field(key, value))];
  if (options.journalTitle?.trim()) clauses.push(`journal_title:(${escape(options.journalTitle)})`);
  if (options.springerProtocol) clauses.push("origin:(springer_link)");
  if (options.openAccess) clauses.push("is_open_access:(true)");
  if (options.articleDoi?.trim()) clauses.push(`article_doi:(${escape(options.articleDoi)})`);
  if (options.publishedFrom && options.publishedTo) clauses.push(`published:[${options.publishedFrom} TO ${options.publishedTo}]`);
  return clauses.filter(Boolean).join(" AND ");
}

/** Build the exact public search URL consumed by protocols.io's current UI. */
export function protocolsIoSearchUrl(query: string, options: ProtocolsIoSearchOptions = {}): string {
  validateOptions(options as Record<string, unknown>);
  options = effectiveProtocolsIoSearchOptions(options);
  const params: string[] = [];
  const advanced = options.mode === "advanced";

  if (advanced) {
    const fields: Array<{ key: ProtocolsIoAdvancedField; value: string }> = [];
    const addField = (key: ProtocolsIoAdvancedField, value: string): void => {
      const trimmed = value.trim();
      if (trimmed) fields.push({ key, value: trimmed });
    };
    addField("all", query);
    for (const value of values(options.tags)) addField("keywords", value);
    for (const { field, value } of options.fields ?? []) addField(field, value);
    const state = {
      fields,
      springer_protocol: options.springerProtocol ?? false,
      open_access: options.openAccess ?? false,
      ...(options.journalTitle?.trim() ? { journal_title: options.journalTitle.trim() } : {}),
      ...(options.articleDoi?.trim() ? { article_doi: options.articleDoi.trim() } : {}),
      ...(options.publishedFrom?.trim() ? { published_from: options.publishedFrom.trim() } : {}),
      ...(options.publishedTo?.trim() ? { published_to: options.publishedTo.trim() } : {}),
    };
    addParam(params, "q", JSON.stringify(state));
    params.push("is_advanced=1");
  } else {
    addParam(params, "q", query.trim());
    if (options.access) params.push(`access=${options.access.join(",")}`);
    for (const [key, list] of [
      ["techniques", options.techniques],
      ["antibodies", options.antibodies],
      ["organisms", options.organisms],
      ["cell_lines", options.cellLines],
    ] as const) {
      const selected = values(list);
      if (selected.length) params.push(`${key}=${selected.map(encodeURIComponent).join("%7C")}`);
    }
  }

  if (options.sortBy && options.sortBy !== "relevance") addParam(params, "sort_by", options.sortBy);
  const order = options.order ?? (options.sortBy === "title" ? "asc" : undefined);
  if (order) addParam(params, "sort_dir", order);
  if ((options.page ?? 1) > 1) addParam(params, "page_id", Math.floor(options.page!));

  return `https://www.protocols.io/search?${params.join("&")}`;
}
