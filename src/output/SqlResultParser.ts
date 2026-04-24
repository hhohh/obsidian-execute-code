/**
 * Universal SQL output parser.
 * Supports CSV, DuckDB (duckbox with Unicode box-drawing), psql, mysql, and other formats.
 */

export interface SqlResultData {
	columns: string[];
	records: Record<string, string>[];
	rowCount?: number;
}

/**
 * Parse raw SQL CLI output text into structured data.
 * Attempts multiple format detections in order:
 * 1. CSV format (comma-separated with header row)
 * 2. DuckDB duckbox format (Unicode box-drawing characters)
 * 3. Pipe-delimited format (psql, mysql)
 * 4. Tab-separated format
 *
 * @param rawOutput The raw stdout text from a SQL CLI tool
 * @returns Parsed result data, or null if parsing fails
 */
export function parseSqlOutput(rawOutput: string): SqlResultData | null {
	if (!rawOutput || rawOutput.trim().length === 0) return null;

	// Try DuckDB duckbox format first (Unicode box-drawing)
	let result = parseDuckBoxFormat(rawOutput);
	if (result) return result;

	// Try pipe-delimited format (psql, mysql)
	result = parsePipeDelimitedFormat(rawOutput);
	if (result) return result;

	// Try CSV format (comma-separated)
	result = parseCsvFormat(rawOutput);
	if (result) return result;

	// Try tab-separated format
	result = parseTabSeparatedFormat(rawOutput);
	if (result) return result;

	return null;
}

/**
 * Parse CSV format output.
 * First line is headers (comma-separated), subsequent lines are data rows.
 * Handles quoted fields with commas and newlines inside.
 *
 * Example:
 * gc_id,ord_id_key,ord_date,amount
 * 01df8878-b5cc-4c28,FFO-CN041-342910,2026-03-29,20500
 * a2b3c4d5-e6f7-8a9b,"value with, comma",2026-04-01,15000
 */
function parseCsvFormat(rawOutput: string): SqlResultData | null {
	const lines = rawOutput.split('\n');

	// Filter out empty lines at the end
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
		lines.pop();
	}

	if (lines.length < 1) return null; // Allow header-only or 1-row data if it looks like CSV

	// Header must contain at least one comma and no box-drawing or pipe chars
	// Header validation: check for box-drawing or pipe chars (which indicate other formats)
	const headerLine = lines[0].trim();
	if (headerLine.includes('│') || headerLine.includes('┌')) return null;

	// Parse header
	const columns = parseCsvLine(headerLine);
	if (columns.length < 1) return null;

	// Validate that columns look like headers (no pure numeric headers is fine, but check for empty)
	if (columns.some(col => col.trim() === '')) return null;

	const records: Record<string, string>[] = [];

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === '') continue;

		const cells = parseCsvLine(line);

		// Build record - handle rows with fewer/more cells than columns
		const record: Record<string, string> = {};
		columns.forEach((col, j) => {
			record[col] = cells[j] !== undefined ? cells[j] : '';
		});
		records.push(record);
	}

	// If we have columns but no records, it's a header-only result (valid for some queries)
	if (records.length === 0 && lines.length > 1) return null; 
	// If only 1 line and it doesn't have a comma, it's probably not CSV
	if (lines.length === 1 && !lines[0].includes(',')) return null;

	return { columns, records, rowCount: records.length };
}

/**
 * Parse a single CSV line, respecting quoted fields.
 * Handles: "field with, comma", "field with ""quotes""", normal field
 */
function parseCsvLine(line: string): string[] {
	const result: string[] = [];
	let current = '';
	let inQuotes = false;
	let i = 0;

	while (i < line.length) {
		const char = line[i];

		if (inQuotes) {
			if (char === '"') {
				// Check for escaped quote ""
				if (i + 1 < line.length && line[i + 1] === '"') {
					current += '"';
					i += 2;
					continue;
				} else {
					// End of quoted field
					inQuotes = false;
					i++;
					continue;
				}
			} else {
				current += char;
				i++;
			}
		} else {
			if (char === '"') {
				inQuotes = true;
				i++;
			} else if (char === ',') {
				result.push(current.trim());
				current = '';
				i++;
			} else {
				current += char;
				i++;
			}
		}
	}

	// Push the last field
	result.push(current.trim());

	return result;
}

/**
 * Parse DuckDB's duckbox format output.
 * Uses Unicode box-drawing characters: ┌ ─ ┐ │ ├ ┤ └ ┘
 */
function parseDuckBoxFormat(rawOutput: string): SqlResultData | null {
	const lines = rawOutput.split('\n');

	const hasBoxChars = lines.some(l => l.includes('┌') || l.includes('├') || l.includes('└'));
	if (!hasBoxChars) return null;

	const dataRows: string[][] = [];
	let headerRow: string[] | null = null;
	let typeRow: string[] | null = null;
	let inHeader = false;
	let inData = false;
	let rowCount: number | undefined;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith('┌') && trimmed.includes('─')) {
			inHeader = true;
			continue;
		}
		if (trimmed.startsWith('├') && trimmed.includes('─')) {
			inHeader = false;
			inData = true;
			continue;
		}
		if (trimmed.startsWith('└') && trimmed.includes('─')) {
			inData = false;
			continue;
		}

		if (trimmed.startsWith('│') && trimmed.endsWith('│')) {
			const cells = trimmed
				.slice(1, -1)
				.split('│')
				.map(cell => cell.trim());

			if (inHeader && !headerRow) {
				headerRow = cells;
			} else if (inHeader && headerRow) {
				typeRow = cells;
			} else if (inData) {
				dataRows.push(cells);
			}
			continue;
		}

		const rowCountMatch = trimmed.match(/^(\d+)\s+rows?$/);
		if (rowCountMatch) {
			rowCount = parseInt(rowCountMatch[1]);
		}
	}

	if (!headerRow || headerRow.length === 0) return null;

	const columns = headerRow;
	const records = dataRows.map(row => {
		const record: Record<string, string> = {};
		columns.forEach((col, i) => {
			record[col] = row[i] !== undefined ? row[i] : '';
		});
		return record;
	});

	// Support 0 records if columns exist (header only)
	return { columns, records, rowCount: rowCount ?? records.length };
}

/**
 * Parse pipe-delimited format (psql, mysql).
 */
function parsePipeDelimitedFormat(rawOutput: string): SqlResultData | null {
	const lines = rawOutput.split('\n').filter(l => l.trim().length > 0);

	if (!lines.some(l => l.includes('|'))) return null;

	const dataRows: string[][] = [];
	let headerRow: string[] | null = null;
	let rowCount: number | undefined;
	let headerFound = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.match(/^[\-\+\=]+$/) || trimmed.match(/^\+[\-\+]+\+$/)) {
			if (headerFound) continue;
			headerFound = true;
			continue;
		}

		const rowCountMatch = trimmed.match(/^\((\d+)\s+rows?\)$/);
		if (rowCountMatch) {
			rowCount = parseInt(rowCountMatch[1]);
			continue;
		}

		if (!trimmed.includes('|')) continue;

		let cells: string[];
		if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
			cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
		} else {
			cells = trimmed.split('|').map(c => c.trim());
		}

		if (!headerRow) {
			headerRow = cells;
		} else {
			dataRows.push(cells);
		}
	}

	if (!headerRow || headerRow.length === 0) return null;

	const columns = headerRow;
	const records = dataRows.map(row => {
		const record: Record<string, string> = {};
		columns.forEach((col, i) => {
			record[col] = row[i] !== undefined ? row[i] : '';
		});
		return record;
	});

	return { columns, records, rowCount: rowCount ?? records.length };
}

/**
 * Parse tab-separated output format.
 */
function parseTabSeparatedFormat(rawOutput: string): SqlResultData | null {
	const lines = rawOutput.split('\n').filter(l => l.trim().length > 0);
	if (lines.length < 2) return null;

	if (!lines[0].includes('\t')) return null;

	const columns = lines[0].split('\t').map(c => c.trim());
	const records: Record<string, string>[] = [];

	for (let i = 1; i < lines.length; i++) {
		const cells = lines[i].split('\t').map(c => c.trim());
		if (cells.length !== columns.length) continue;

		const record: Record<string, string> = {};
		columns.forEach((col, j) => {
			record[col] = cells[j] !== undefined ? cells[j] : '';
		});
		records.push(record);
	}

	if (records.length === 0) return null;

	return { columns, records, rowCount: records.length };
}
