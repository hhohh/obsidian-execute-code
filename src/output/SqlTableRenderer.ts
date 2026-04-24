/**
 * SQL Table Renderer using VTable (VisActor).
 * Renders SQL query results as a high-performance table with export capabilities.
 */

import * as VTable from '@visactor/vtable';
import { exportVTableToCsv, downloadCsv } from '@visactor/vtable-export';
import type { SqlResultData } from './SqlResultParser';

/** Store VTable instances for cleanup */
const vtableInstances = new Map<HTMLElement, VTable.ListTable>();

/**
 * Render SQL result data into a VTable ListTable.
 *
 * @param data Parsed SQL result data
 * @param container DOM container to render into
 * @param isDarkMode Whether Obsidian is in dark mode
 * @returns The VTable instance, or null on failure
 */
export function renderSqlTable(
	data: SqlResultData,
	container: HTMLElement,
	isDarkMode: boolean,
	onDelete?: () => void
): VTable.ListTable | null {
	if (!data || !data.columns || data.columns.length === 0) return null;

	// Clean up any previous instance in this container
	destroySqlTable(container);

	// Create header bar with info + export buttons (above table, no overlap)
	const headerBar = document.createElement('div');
	headerBar.className = 'sql-vtable-header-bar';

	const info = document.createElement('span');
	info.className = 'sql-vtable-info';
	info.textContent = `${data.records.length} rows × ${data.columns.length} columns`;
	headerBar.appendChild(info);

	const btnGroup = document.createElement('div');
	btnGroup.className = 'sql-vtable-btn-group';

	// CSV Export button
	const csvBtn = document.createElement('button');
	csvBtn.className = 'sql-vtable-export-btn';
	csvBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> CSV';
	csvBtn.title = 'Export to CSV';
	csvBtn.setAttribute('data-export', 'csv');
	btnGroup.appendChild(csvBtn);

	// Excel Export button
	const excelBtn = document.createElement('button');
	excelBtn.className = 'sql-vtable-export-btn';
	excelBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Excel';
	excelBtn.title = 'Export to Excel';
	excelBtn.setAttribute('data-export', 'excel');
	btnGroup.appendChild(excelBtn);

	// Delete button
	const deleteBtn = document.createElement('button');
	deleteBtn.className = 'sql-vtable-export-btn sql-vtable-delete-btn';
	deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg> Delete';
	deleteBtn.title = 'Delete this result';
	deleteBtn.style.marginLeft = 'auto'; // Push to far right
	deleteBtn.style.marginRight = '8px';
	deleteBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (confirm('Delete this SQL result from the note?')) {
			if (onDelete) onDelete();
			container.remove();
		}
	});
	btnGroup.appendChild(deleteBtn);

	headerBar.appendChild(btnGroup);

	// Table container for VTable canvas
	const tableContainer = document.createElement('div');
	tableContainer.className = 'sql-vtable-container';

	// Calculate dimensions
	const rowHeight = 34;
	const headerHeight = 38;
	const maxHeight = 500;
	const calculatedHeight = Math.min(
		headerHeight + data.records.length * rowHeight + 4,
		maxHeight
	);
	tableContainer.style.height = `${calculatedHeight}px`;
	tableContainer.style.width = '100%';

	container.appendChild(headerBar);
	container.appendChild(tableContainer);

	// Build VTable columns config - width based on title content
	const columns: VTable.ColumnsDefine = data.columns.map(col => ({
		field: col,
		title: col,
		width: 'auto',
		sort: true,
		style: {
			textAlign: 'left',
			padding: [6, 10, 6, 10],
		},
		headerStyle: {
			textAlign: 'left',
			fontWeight: 'bold',
			padding: [8, 10, 8, 10],
		}
	}));

	// Create the VTable instance with default theme
	const option: VTable.ListTableConstructorOptions = {
		container: tableContainer,
		records: data.records,
		columns: columns,
		// Use default theme
		theme: isDarkMode ? VTable.themes.DARK : VTable.themes.DEFAULT,
		autoWrapText: false,
		heightMode: 'autoHeight',
		widthMode: 'standard',
		autoFillWidth: true,
		hover: {
			highlightMode: 'row',
		},
		select: {
			disableSelect: false,
			highlightMode: 'cell',
		},
		tooltip: {
			isShowOverflowTextTooltip: true,
		},
		rowSeriesNumber: {
			title: '#',
			width: 'auto',
			headerStyle: {
				textAlign: 'center',
				fontWeight: 'bold',
			},
			style: {
				textAlign: 'center',
			},
		},
		// Keyboard support: CMD/CTRL+C to copy selected cells
		keyboardOptions: {
			copySelected: true,
			selectAllOnCtrlA: true,
		},
		// Context menu for copying
		menu: {
			contextMenuItems: [
				{ menuKey: 'copy-tab', text: 'Copy with Tab Separator' },
				{ menuKey: 'copy-comma', text: 'Copy with Comma Separator' }
			]
		},
		frozenColCount: 0,
	};

	try {
		const tableInstance = new VTable.ListTable(option);
		vtableInstances.set(container, tableInstance);

		// Wire up export buttons
		wireExportButtons(headerBar, tableInstance, data);

		// Click row number to select entire row, or # to select all
		tableInstance.on('click_cell', (args: any) => {
			if (args.col === 0 && args.row === 0) {
				// Select all cells including headers and row numbers
				tableInstance.selectCells([
					{ start: { col: 0, row: 0 }, end: { col: tableInstance.colCount - 1, row: tableInstance.rowCount - 1 } }
				]);
			} else if (args.col === 0 && args.row > 0) {
				tableInstance.selectRow(args.row);
			}
		});

		// Handle context menu clicks
		tableInstance.on('dropdown_menu_click', (args: any) => {
			if (args.menuKey === 'copy-tab' || args.menuKey === 'copy-comma') {
				const separator = args.menuKey === 'copy-tab' ? '\t' : ',';
				const copyData = tableInstance.getCopyValue();
				if (copyData) {
					// VTable default copy is tab-separated. If comma needed, replace.
					const finalData = separator === ',' ? copyData.replace(/\t/g, ',') : copyData;
					navigator.clipboard.writeText(finalData);
				}
			}
		});

		return tableInstance;
	} catch (e) {
		console.error('Failed to create VTable instance:', e);
		return null;
	}
}

/**
 * Destroy a VTable instance associated with a container.
 */
export function destroySqlTable(container: HTMLElement) {
	const existing = vtableInstances.get(container);
	if (existing) {
		try {
			existing.release();
		} catch (e) {
			// ignore
		}
		vtableInstances.delete(container);
	}
	container.innerHTML = '';
}

/**
 * Wire export button click handlers to a VTable instance.
 */
function wireExportButtons(headerBar: HTMLElement, tableInstance: VTable.ListTable, data: SqlResultData) {
	const csvBtn = headerBar.querySelector('[data-export="csv"]');
	const excelBtn = headerBar.querySelector('[data-export="excel"]');

	if (csvBtn) {
		csvBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			try {
				const csvContent = exportVTableToCsv(tableInstance);
				downloadCsv(csvContent, `sql-result-${Date.now()}`);
			} catch (e) {
				console.error('CSV export failed:', e);
				exportCsvFallback(data);
			}
		});
	}

	if (excelBtn) {
		excelBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			try {
				const { downloadExcel, exportVTableToExcel } = await import('@visactor/vtable-export');
				// Use formatExportOutput to ensure text-based headers and content
				const buffer = await exportVTableToExcel(tableInstance, {
					exportAllData: true,
					formatExportOutput: (cellInfo: any) => {
						return cellInfo.value;
					}
				});
				downloadExcel(buffer, `sql-result-${Date.now()}`);
			} catch (e) {
				console.error('Excel export failed, falling back to CSV:', e);
				exportCsvFallback(data);
			}
		});
	}
}

/**
 * Fallback CSV export using raw data (when VTable export fails).
 */
function exportCsvFallback(data: SqlResultData) {
	const escapeCell = (val: string) => {
		if (val.includes(',') || val.includes('"') || val.includes('\n')) {
			return `"${val.replace(/"/g, '""')}"`;
		}
		return val;
	};

	const header = data.columns.map(escapeCell).join(',');
	const rows = data.records.map(record =>
		data.columns.map(col => escapeCell(record[col] || '')).join(',')
	);
	const csv = [header, ...rows].join('\n');

	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `sql-result-${Date.now()}.csv`;
	a.click();
	URL.revokeObjectURL(url);
}
