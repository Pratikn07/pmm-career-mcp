import { createHash } from "node:crypto";
import JSZip from "jszip";

const MAX_COMPANIES = 50;
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const ZIP_TIMESTAMP = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const OOXML_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XML_DECLARATION = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";

const SHEET_NAMES = [
  "Ready to Review",
  "Needs Verification",
  "Not Found - Failed",
  "Run Summary"
] as const;

const READY_COLUMNS = [
  "Company",
  "YC Batch",
  "Company Status",
  "Hiring",
  "Company Website",
  "Founder",
  "Founder Role",
  "LinkedIn URL",
  "URL Status",
  "Profile Evidence",
  "Checked At",
  "Confidence",
  "Personalization Rationale",
  "Draft Connection Note",
  "Note Review Status",
  "Outreach Status",
  "Person ID",
  "Target ID",
  "Draft ID"
] as const;

const NEEDS_VERIFICATION_COLUMNS = [
  "Company",
  "YC Batch",
  "Company Status",
  "Hiring",
  "Company Website",
  "Founder",
  "Founder Role",
  "Candidate LinkedIn URL",
  "URL Status",
  "Search Query",
  "Evidence URL",
  "Evidence Snippet",
  "Checked At",
  "Confidence",
  "Required Manual Action",
  "Person ID"
] as const;

const FAILURE_COLUMNS = [
  "Company",
  "YC Batch",
  "Company Status",
  "Hiring",
  "Company Website",
  "Founder",
  "Founder Role",
  "Result State",
  "Checked At",
  "Confidence",
  "Error Code",
  "Error Summary"
] as const;

const EXPECTED_ENTRY_NAMES = [
  "[Content_Types].xml",
  "_rels/.rels",
  "docProps/app.xml",
  "docProps/core.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/workbook.xml",
  "xl/worksheets/sheet1.xml",
  "xl/worksheets/sheet2.xml",
  "xl/worksheets/sheet3.xml",
  "xl/worksheets/sheet4.xml"
] as const;

type WorkbookRowState =
  | "CONFIRMED"
  | "VERIFIED"
  | "CANDIDATE"
  | "AMBIGUOUS"
  | "NOT_FOUND"
  | "FAILED";

type WorkbookRunState =
  | "PENDING"
  | "RUNNING"
  | "NEEDS_PUBLIC_SEARCH"
  | "COMPLETE"
  | "PARTIAL"
  | "FAILED";

export type FounderResearchWorkbookRun = Readonly<{
  id: string;
  state: WorkbookRunState;
  filters: Readonly<Record<string, boolean | number | string>>;
  requestedLimit: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}>;

export type FounderResearchWorkbookRow = Readonly<{
  id: string;
  state: WorkbookRowState;
  companyName: string;
  ycBatch?: string;
  companyStatus?: string;
  hiring?: boolean;
  companyWebsiteUrl?: string;
  founderName?: string;
  founderRole?: string;
  canonicalProfileUrl?: string;
  candidateProfileUrl?: string;
  profileEvidence?: string;
  searchQuery?: string;
  evidenceUrl?: string;
  evidenceSnippet?: string;
  checkedAt: string;
  confidence: number;
  personalizationRationale?: string;
  draftConnectionNote?: string;
  noteReviewStatus?: string;
  outreachStatus?: string;
  requiredManualAction?: string;
  personId?: string;
  targetId?: string;
  draftId?: string;
  errorCode?: string;
  errorSummary?: string;
}>;

export type FounderResearchWorkbookInput = Readonly<{
  run: FounderResearchWorkbookRun;
  rows: readonly FounderResearchWorkbookRow[];
  includeCandidateUrls?: boolean;
}>;

type CellValue = string | number | Date;
type Cell = Readonly<{ value: CellValue; style?: 1 | 2 | 3 }>;
type PreparedRow = FounderResearchWorkbookRow & Readonly<{ checkedDate: Date }>;

function invalidInput(reason: string): never {
  throw new Error(`Invalid founder research workbook input: ${reason}`);
}

function boundedText(field: string, value: unknown, required = false): string | undefined {
  if (value === undefined) {
    if (required) invalidInput(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    invalidInput(`${field} must be a non-empty bounded string`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    invalidInput(`${field} contains unsafe control characters`);
  }
  return value.normalize("NFC");
}

function optionalText(field: string, value: unknown): string | undefined {
  return boundedText(field, value, false);
}

function requiredText(field: string, value: unknown): string {
  return boundedText(field, value, true)!;
}

function timestamp(field: string, value: unknown): Date {
  const text = requiredText(field, value);
  const result = new Date(text);
  if (Number.isNaN(result.getTime())) invalidInput(`${field} must be an ISO timestamp`);
  return result;
}

function validateUrl(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
      invalidInput(`${field} must be a credential-free HTTPS URL`);
    }
    return value;
  } catch {
    invalidInput(`${field} must be a URL`);
  }
}

function stableFilters(value: unknown): Record<string, boolean | number | string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidInput("run.filters must be a plain object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort((left, right) => left.localeCompare(right, "en"));
  const output: Record<string, boolean | number | string> = {};
  for (const key of keys) {
    const safeKey = requiredText("run.filters key", key);
    const item = input[key];
    if (typeof item === "string") {
      output[safeKey] = requiredText(`run.filters.${key}`, item);
    } else if (typeof item === "boolean") {
      output[safeKey] = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      output[safeKey] = item;
    } else {
      invalidInput(`run.filters.${key} has an unsupported value`);
    }
  }
  return output;
}

function validateInput(input: FounderResearchWorkbookInput): Readonly<{
  run: FounderResearchWorkbookRun;
  rows: readonly PreparedRow[];
  includeCandidateUrls: boolean;
}> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    invalidInput("input must be an object");
  }
  const run = input.run;
  if (typeof run !== "object" || run === null || Array.isArray(run)) invalidInput("run must be an object");
  const state = requiredText("run.state", run.state);
  if (!(["PENDING", "RUNNING", "NEEDS_PUBLIC_SEARCH", "COMPLETE", "PARTIAL", "FAILED"] as const).includes(state as WorkbookRunState)) {
    invalidInput("run.state is unsupported");
  }
  if (!Number.isInteger(run.requestedLimit) || run.requestedLimit < 1 || run.requestedLimit > MAX_COMPANIES) {
    invalidInput("run.requestedLimit must be between 1 and 50");
  }
  if (!Array.isArray(input.rows) || input.rows.length > run.requestedLimit) {
    invalidInput("rows must not exceed run.requestedLimit");
  }
  if (input.includeCandidateUrls !== undefined && typeof input.includeCandidateUrls !== "boolean") {
    invalidInput("includeCandidateUrls must be boolean when present");
  }
  const seenIds = new Set<string>();
  const rows = input.rows.map((row, index): PreparedRow => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) invalidInput(`rows[${index}] must be an object`);
    const id = requiredText(`rows[${index}].id`, row.id);
    if (seenIds.has(id)) invalidInput(`rows[${index}].id must be unique`);
    seenIds.add(id);
    const rowState = requiredText(`rows[${index}].state`, row.state);
    if (!(["CONFIRMED", "VERIFIED", "CANDIDATE", "AMBIGUOUS", "NOT_FOUND", "FAILED"] as const).includes(rowState as WorkbookRowState)) {
      invalidInput(`rows[${index}].state is unsupported`);
    }
    if (typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1) {
      invalidInput(`rows[${index}].confidence must be between 0 and 1`);
    }
    const normalized: FounderResearchWorkbookRow = {
      ...row,
      id,
      state: rowState as WorkbookRowState,
      companyName: requiredText(`rows[${index}].companyName`, row.companyName),
      ycBatch: optionalText(`rows[${index}].ycBatch`, row.ycBatch),
      companyStatus: optionalText(`rows[${index}].companyStatus`, row.companyStatus),
      hiring: row.hiring,
      companyWebsiteUrl: validateUrl(`rows[${index}].companyWebsiteUrl`, optionalText(`rows[${index}].companyWebsiteUrl`, row.companyWebsiteUrl)),
      founderName: optionalText(`rows[${index}].founderName`, row.founderName),
      founderRole: optionalText(`rows[${index}].founderRole`, row.founderRole),
      canonicalProfileUrl: validateUrl(`rows[${index}].canonicalProfileUrl`, optionalText(`rows[${index}].canonicalProfileUrl`, row.canonicalProfileUrl)),
      candidateProfileUrl: validateUrl(`rows[${index}].candidateProfileUrl`, optionalText(`rows[${index}].candidateProfileUrl`, row.candidateProfileUrl)),
      profileEvidence: optionalText(`rows[${index}].profileEvidence`, row.profileEvidence),
      searchQuery: optionalText(`rows[${index}].searchQuery`, row.searchQuery),
      evidenceUrl: validateUrl(`rows[${index}].evidenceUrl`, optionalText(`rows[${index}].evidenceUrl`, row.evidenceUrl)),
      evidenceSnippet: optionalText(`rows[${index}].evidenceSnippet`, row.evidenceSnippet),
      checkedAt: requiredText(`rows[${index}].checkedAt`, row.checkedAt),
      confidence: row.confidence,
      personalizationRationale: optionalText(`rows[${index}].personalizationRationale`, row.personalizationRationale),
      draftConnectionNote: optionalText(`rows[${index}].draftConnectionNote`, row.draftConnectionNote),
      noteReviewStatus: optionalText(`rows[${index}].noteReviewStatus`, row.noteReviewStatus),
      outreachStatus: optionalText(`rows[${index}].outreachStatus`, row.outreachStatus),
      requiredManualAction: optionalText(`rows[${index}].requiredManualAction`, row.requiredManualAction),
      personId: optionalText(`rows[${index}].personId`, row.personId),
      targetId: optionalText(`rows[${index}].targetId`, row.targetId),
      draftId: optionalText(`rows[${index}].draftId`, row.draftId),
      errorCode: optionalText(`rows[${index}].errorCode`, row.errorCode),
      errorSummary: optionalText(`rows[${index}].errorSummary`, row.errorSummary)
    };
    if (normalized.hiring !== undefined && typeof normalized.hiring !== "boolean") invalidInput(`rows[${index}].hiring must be boolean`);
    if ((normalized.state === "CONFIRMED" || normalized.state === "VERIFIED") && (
      normalized.canonicalProfileUrl === undefined || normalized.draftConnectionNote === undefined || normalized.targetId === undefined || normalized.draftId === undefined
    )) {
      invalidInput(`${normalized.state} rows require a canonical URL and saved outreach draft`);
    }
    if (normalized.state === "CANDIDATE" && normalized.candidateProfileUrl === undefined) {
      invalidInput("CANDIDATE rows require a candidate profile URL");
    }
    if ((normalized.state === "CANDIDATE" || normalized.state === "AMBIGUOUS") && normalized.requiredManualAction === undefined) {
      invalidInput(`${normalized.state} rows require a manual action`);
    }
    if ((normalized.state === "NOT_FOUND" || normalized.state === "FAILED") && normalized.errorSummary === undefined) {
      invalidInput(`${normalized.state} rows require an error summary`);
    }
    return { ...normalized, checkedDate: timestamp(`rows[${index}].checkedAt`, normalized.checkedAt) };
  });
  const preparedRun: FounderResearchWorkbookRun = {
    id: requiredText("run.id", run.id),
    state: state as WorkbookRunState,
    filters: stableFilters(run.filters),
    requestedLimit: run.requestedLimit,
    createdAt: requiredText("run.createdAt", run.createdAt),
    ...(run.startedAt === undefined ? {} : { startedAt: requiredText("run.startedAt", run.startedAt) }),
    ...(run.completedAt === undefined ? {} : { completedAt: requiredText("run.completedAt", run.completedAt) })
  };
  timestamp("run.createdAt", preparedRun.createdAt);
  if (preparedRun.startedAt !== undefined) timestamp("run.startedAt", preparedRun.startedAt);
  if (preparedRun.completedAt !== undefined) timestamp("run.completedAt", preparedRun.completedAt);
  return Object.freeze({ run: preparedRun, rows, includeCandidateUrls: input.includeCandidateUrls ?? true });
}

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&apos;",
    "\"": "&quot;"
  })[character]!);
}

function spreadsheetText(value: string): string {
  const neutralized = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return escapeXml(neutralized);
}

function columnName(index: number): string {
  let remaining = index + 1;
  let output = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    output = String.fromCharCode(65 + digit) + output;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return output;
}

function excelDate(value: Date): number {
  return value.getTime() / 86_400_000 + 25_569;
}

function cell(reference: string, item: Cell): string {
  if (item.value instanceof Date) {
    return `<c r="${reference}" s="${item.style ?? 2}"><v>${excelDate(item.value).toFixed(10)}</v></c>`;
  }
  if (typeof item.value === "number") {
    return `<c r="${reference}"${item.style === undefined ? "" : ` s="${item.style}"`}><v>${item.value}</v></c>`;
  }
  return `<c r="${reference}" t="inlineStr"${item.style === undefined ? "" : ` s="${item.style}"`}><is><t>${spreadsheetText(item.value)}</t></is></c>`;
}

function rowXml(rowNumber: number, values: readonly (Cell | undefined)[]): string {
  const cells = values.map((item, index) => item === undefined ? "" : cell(`${columnName(index)}${rowNumber}`, item)).join("");
  return `<row r="${rowNumber}">${cells}</row>`;
}

function columnXml(widths: readonly number[]): string {
  return `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`;
}

function worksheetXml(
  headers: readonly string[],
  rows: readonly (readonly (Cell | undefined)[])[],
  widths: readonly number[]
): string {
  const lastColumn = columnName(headers.length - 1);
  const lastRow = rows.length + 1;
  return `${XML_DECLARATION}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columnXml(widths)}<sheetData>${rowXml(1, headers.map((value) => ({ value, style: 1 as const })))}${rows.map((row, index) => rowXml(index + 2, row)).join("")}</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`;
}

function byDisplayOrder(left: PreparedRow, right: PreparedRow): number {
  return left.companyName.localeCompare(right.companyName, "en", { sensitivity: "base" })
    || (left.founderName ?? "").localeCompare(right.founderName ?? "", "en", { sensitivity: "base" })
    || left.id.localeCompare(right.id, "en");
}

function readyRow(row: PreparedRow): readonly (Cell | undefined)[] {
  return [
    { value: row.companyName },
    stringCell(row.ycBatch), stringCell(row.companyStatus), booleanCell(row.hiring), stringCell(row.companyWebsiteUrl),
    stringCell(row.founderName), stringCell(row.founderRole), stringCell(row.canonicalProfileUrl), { value: row.state },
    stringCell(row.profileEvidence), { value: row.checkedDate, style: 2 }, { value: row.confidence, style: 3 },
    stringCell(row.personalizationRationale), stringCell(row.draftConnectionNote), stringCell(row.noteReviewStatus),
    stringCell(row.outreachStatus), stringCell(row.personId), stringCell(row.targetId), stringCell(row.draftId)
  ];
}

function needsVerificationRow(row: PreparedRow, includeCandidateUrls: boolean): readonly (Cell | undefined)[] {
  return [
    { value: row.companyName },
    stringCell(row.ycBatch), stringCell(row.companyStatus), booleanCell(row.hiring), stringCell(row.companyWebsiteUrl),
    stringCell(row.founderName), stringCell(row.founderRole), stringCell(includeCandidateUrls ? row.candidateProfileUrl : undefined),
    { value: row.state === "CANDIDATE" ? "Candidate URL (unverified)" : "Identity ambiguous" },
    stringCell(row.searchQuery), stringCell(row.evidenceUrl), stringCell(row.evidenceSnippet),
    { value: row.checkedDate, style: 2 }, { value: row.confidence, style: 3 }, stringCell(row.requiredManualAction), stringCell(row.personId)
  ];
}

function failureRow(row: PreparedRow): readonly (Cell | undefined)[] {
  return [
    { value: row.companyName },
    stringCell(row.ycBatch), stringCell(row.companyStatus), booleanCell(row.hiring), stringCell(row.companyWebsiteUrl),
    stringCell(row.founderName), stringCell(row.founderRole), { value: row.state }, { value: row.checkedDate, style: 2 },
    { value: row.confidence, style: 3 }, stringCell(row.errorCode), stringCell(row.errorSummary)
  ];
}

function stringCell(value: string | undefined): Cell | undefined {
  return value === undefined ? undefined : { value };
}

function booleanCell(value: boolean | undefined): Cell | undefined {
  return value === undefined ? undefined : { value: value ? "Yes" : "No" };
}

function summaryRows(run: FounderResearchWorkbookRun, rows: readonly PreparedRow[]): readonly (readonly (Cell | undefined)[])[] {
  const count = (state: WorkbookRowState) => rows.filter((row) => row.state === state).length;
  const processed = rows.filter((row) => row.state !== "AMBIGUOUS" || row.checkedDate !== undefined).length;
  const contentChecksum = createHash("sha256")
    .update(JSON.stringify({ run, rows: rows.map(({ checkedDate: _checkedDate, ...row }) => row) }))
    .digest("hex");
  return [
    [{ value: "Run ID" }, { value: run.id }],
    [{ value: "Run State" }, { value: run.state }],
    [{ value: "Filters" }, { value: JSON.stringify(run.filters) }],
    [{ value: "Created At" }, { value: timestamp("run.createdAt", run.createdAt), style: 2 }],
    [{ value: "Started At" }, run.startedAt === undefined ? undefined : { value: timestamp("run.startedAt", run.startedAt), style: 2 }],
    [{ value: "Completed At" }, run.completedAt === undefined ? undefined : { value: timestamp("run.completedAt", run.completedAt), style: 2 }],
    [{ value: "Selected Companies" }, { value: rows.length }],
    [{ value: "Processed Companies" }, { value: processed }],
    [{ value: "Confirmed" }, { value: count("CONFIRMED") }],
    [{ value: "Verified" }, { value: count("VERIFIED") }],
    [{ value: "Candidate" }, { value: count("CANDIDATE") }],
    [{ value: "Ambiguous" }, { value: count("AMBIGUOUS") }],
    [{ value: "Not Found" }, { value: count("NOT_FOUND") }],
    [{ value: "Failed" }, { value: count("FAILED") }],
    [{ value: "Evidence Freshness Policy" }, { value: "Evidence older than 30 days should be refreshed while historical rows are retained." }],
    [{ value: "Workbook Content Checksum (SHA-256)" }, { value: contentChecksum }],
    [{ value: "Manual Review" }, { value: "Connection requests must be reviewed and sent manually on LinkedIn." }]
  ];
}

function contentTypesXml(): string {
  return `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1, 2, 3, 4].map((number) => `<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`;
}

function rootRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function appPropertiesXml(): string {
  return `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PMM Career MCP</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>4</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="4" baseType="lpstr">${SHEET_NAMES.map((name) => `<vt:lpstr>${escapeXml(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`;
}

function corePropertiesXml(): string {
  return `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PMM Career MCP</dc:creator><cp:lastModifiedBy>PMM Career MCP</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`;
}

function workbookXml(): string {
  return `${XML_DECLARATION}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView/></bookViews><sheets>${SHEET_NAMES.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets></workbook>`;
}

function workbookRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3, 4].map((number) => `<Relationship Id="rId${number}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/>`).join("")}<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml(): string {
  return `${XML_DECLARATION}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

async function validatePackage(bytes: Buffer): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error("Generated founder research workbook is outside the allowed size");
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);
  if (entries.length !== EXPECTED_ENTRY_NAMES.length || entries.some((entry, index) => entry !== EXPECTED_ENTRY_NAMES[index])) {
    throw new Error("Generated founder research workbook has unexpected package entries");
  }
  const xml = (await Promise.all(entries.filter((entry) => entry.endsWith(".xml")).map(async (entry) => zip.file(entry)!.async("string")))).join("\n");
  if (/<f(?: |>)/u.test(xml) || /<hyperlinks?(?: |>)/u.test(xml) || /<definedNames?(?: |>)/u.test(xml) || /<(?:drawing|legacyDrawing|picture)(?: |>)/u.test(xml) || /externalLink|vbaProject|sharedStrings|state="hidden"|hidden="1"/u.test(xml)) {
    throw new Error("Generated founder research workbook contains forbidden OOXML content");
  }
}

/**
 * Creates one deterministic, in-memory XLSX package from a validated display
 * projection. This function performs no I/O other than its in-memory ZIP work.
 */
export async function buildFounderResearchWorkbook(input: FounderResearchWorkbookInput): Promise<Buffer> {
  const prepared = validateInput(input);
  const orderedRows = [...prepared.rows].sort(byDisplayOrder);
  const ready = orderedRows.filter((row) => row.state === "CONFIRMED" || row.state === "VERIFIED");
  const needsVerification = orderedRows.filter((row) => row.state === "CANDIDATE" || row.state === "AMBIGUOUS");
  const failures = orderedRows.filter((row) => row.state === "NOT_FOUND" || row.state === "FAILED");
  const summary = summaryRows(prepared.run, orderedRows);
  const sheets = [
    worksheetXml(READY_COLUMNS, ready.map(readyRow), [24, 12, 16, 10, 28, 22, 22, 38, 14, 42, 20, 12, 42, 48, 18, 16, 36, 36, 36]),
    worksheetXml(NEEDS_VERIFICATION_COLUMNS, needsVerification.map((row) => needsVerificationRow(row, prepared.includeCandidateUrls)), [24, 12, 16, 10, 28, 22, 22, 38, 24, 42, 38, 48, 20, 12, 36, 36]),
    worksheetXml(FAILURE_COLUMNS, failures.map(failureRow), [24, 12, 16, 10, 28, 22, 22, 18, 20, 12, 28, 54]),
    worksheetXml(["Metric", "Value"], summary, [38, 96])
  ];
  const entries: readonly (readonly [string, string])[] = [
    ["[Content_Types].xml", contentTypesXml()],
    ["_rels/.rels", rootRelationshipsXml()],
    ["docProps/app.xml", appPropertiesXml()],
    ["docProps/core.xml", corePropertiesXml()],
    ["xl/_rels/workbook.xml.rels", workbookRelationshipsXml()],
    ["xl/styles.xml", stylesXml()],
    ["xl/workbook.xml", workbookXml()],
    ["xl/worksheets/sheet1.xml", sheets[0]!],
    ["xl/worksheets/sheet2.xml", sheets[1]!],
    ["xl/worksheets/sheet3.xml", sheets[2]!],
    ["xl/worksheets/sheet4.xml", sheets[3]!]
  ];
  const zip = new JSZip();
  for (const [name, content] of entries) {
    zip.file(name, content, {
      date: ZIP_TIMESTAMP,
      createFolders: false,
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    mimeType: OOXML_CONTENT_TYPE,
    platform: "DOS",
    comment: ""
  });
  await validatePackage(bytes);
  return bytes;
}
