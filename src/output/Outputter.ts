import { EventEmitter } from "events";
import loadEllipses from "../svgs/loadEllipses";
import loadSpinner from "../svgs/loadSpinner";
import FileAppender from "./FileAppender";
import { App, Component, MarkdownRenderer, MarkdownView, normalizePath, setIcon, MarkdownPostProcessorContext } from "obsidian";
import { ExecutorSettings } from "../settings/Settings";
import { ChildProcess } from "child_process";
import { parseSqlOutput, SqlResultData } from "./SqlResultParser";
import { renderSqlTable, destroySqlTable } from "./SqlTableRenderer";
import type { LanguageId } from "../main";

export const TOGGLE_HTML_SIGIL = `TOGGLE_HTML_${Math.random().toString(16).substring(2)}`;

export class Outputter extends EventEmitter {
	codeBlockElement: HTMLElement;
	outputElement: HTMLElement;
	clearButton: HTMLButtonElement;
	lastPrintElem: HTMLSpanElement;
	lastPrinted: string;

	inputElement: HTMLInputElement;

	loadStateIndicatorElement: HTMLElement;

	htmlBuffer: string
	escapeHTML: boolean
	hadPreviouslyPrinted: boolean;
	inputState: "NOT_DOING" | "OPEN" | "CLOSED" | "INACTIVE";

	blockRunState: "RUNNING" | "QUEUED" | "FINISHED" | "INITIAL";

	saveToFile: FileAppender;
	settings: ExecutorSettings;


	runningSubprocesses = new Set<ChildProcess>();
	app: App;
	srcFile: string;

	/** The language of the code block */
	language: LanguageId | undefined;

	/** Container for SQL VTable rendering */
	private sqlTableContainer: HTMLElement | null = null;

	/** Accumulated SQL output buffer */
	private sqlOutputBuffer: string = '';

	/** The index of the code block in the current processing context */
	private blockIndex: number;

	/** Post-processor context for identifying block location */
	private context: MarkdownPostProcessorContext | undefined;

	constructor(codeBlock: HTMLElement, settings: ExecutorSettings, view: MarkdownView, app: App, srcFile: string, language?: LanguageId, context?: MarkdownPostProcessorContext, blockIndex: number = 0) {
		super();
		this.settings = settings;
		this.app = app;
		this.srcFile = srcFile;
		this.language = language;
		this.context = context;
		this.blockIndex = blockIndex;

		this.inputState = this.settings.allowInput ? "INACTIVE" : "NOT_DOING";
		this.codeBlockElement = codeBlock;
		this.hadPreviouslyPrinted = false;
		this.escapeHTML = true;
		this.htmlBuffer = "";
		this.blockRunState = "INITIAL";

		this.saveToFile = new FileAppender(view, codeBlock.parentElement as HTMLPreElement);
	}

	/**
	 * Clears the output log.
	 */
	clear() {
		if (this.outputElement) {
			for (const child of Array.from(this.outputElement.children)) {
				if (child instanceof HTMLSpanElement)
					this.outputElement.removeChild(child);
			}
		}
		this.lastPrintElem = null;
		this.hadPreviouslyPrinted = false;
		this.lastPrinted = "";

		if (this.clearButton)
			this.clearButton.className = "clear-button-disabled";

		this.closeInput();
		this.inputState = "INACTIVE";

		// Clean up SQL VTable
		if (this.sqlTableContainer) {
			destroySqlTable(this.sqlTableContainer);
			this.sqlTableContainer.remove();
			this.sqlTableContainer = null;
		}
		this.sqlOutputBuffer = '';

		// clear output block in file
		this.saveToFile.clearOutput();

		// Kill code block
		this.killBlock(this.runningSubprocesses);
	}

	/**
	 * Kills the code block.
	 * To be overwritten in an executor's run method
	 */
	killBlock(subprocesses?: Set<ChildProcess>) { }

	/**
	 * Hides the output and clears the log. Visually, restores the code block to its initial state.
	 */
	delete() {
		if (this.outputElement)
			this.outputElement.style.display = "none";

		this.clear()
	}

	/**
	 * Add a segment of stdout data to the outputter.
	 * For SQL language, accumulates output in buffer.
	 * @param text The stdout data in question
	 */
	write(text: string) {
		if (this.language === 'sql') {
			// For SQL, accumulate output in buffer
			this.sqlOutputBuffer += text;
			return;
		}
		this.processSigilsAndWriteText(text);
	}

	/**
	 * Finalize SQL output: parse the accumulated buffer and render as VTable.
	 * Called when the SQL execution is complete.
	 */
	finalizeSqlOutput() {
		const rawOutput = this.sqlOutputBuffer;
		this.sqlOutputBuffer = '';

		if (!rawOutput || rawOutput.trim().length === 0) return;

		const parsed = parseSqlOutput(rawOutput);

		if (parsed && parsed.columns.length > 0 && parsed.records.length > 0) {
			// Persist SQL results directly to the note file.
			// This will insert a ```vtable block which handles its own rendering.
			this.persistSqlResultToFile(parsed);
		} else {
			// Fallback: render as plain text if parsing fails
			this.processSigilsAndWriteText(rawOutput);
		}
	}

	/**
	 * Persist SQL result data to the markdown file by directly modifying the file content.
	 * Uses Vault API instead of FileAppender to work reliably in both Live Preview and Reading View.
	 */
	/**
	 * Persist SQL result data to the markdown file.
	 * Prioritizes using the Editor API if the file is currently active, 
	 * falling back to direct Vault API modification otherwise.
	 */
	private async persistSqlResultToFile(data: SqlResultData) {
		console.log(`[Execute Code] Persisting SQL result to ${this.srcFile}`);
		try {
			const jsonPayload = JSON.stringify(data);
			const vtableBlock = `\n\`\`\`vtable\n${jsonPayload}\n\`\`\``;

			// Try to find the active markdown editor for this file
			const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const isSameFile = activeView && activeView.file && activeView.file.path === this.srcFile;

			if (isSameFile) {
				console.log(`[Execute Code] Using Editor API for persistence`);
				const editor = activeView.editor;
				
				let sectionInfo = this.context ? this.context.getSectionInfo(this.codeBlockElement) : null;
				if (!sectionInfo && this.context) {
					sectionInfo = this.context.getSectionInfo(this.codeBlockElement.parentElement) || 
								  this.context.getSectionInfo(this.codeBlockElement.closest('pre'));
				}

				let insertLine = -1;
				if (sectionInfo) {
					insertLine = sectionInfo.lineEnd;
				} else {
					insertLine = this.findCodeBlockEndLine(editor.getValue());
				}

				if (insertLine !== -1) {
					// Check for existing vtable block right after
					const nextLine = editor.getLine(insertLine + 1);
					const hasExistingVTable = nextLine && nextLine.trim() === '```vtable';

					if (hasExistingVTable) {
						let endLine = insertLine + 1;
						while (endLine < editor.lineCount()) {
							if (editor.getLine(endLine).trim() === '```' && endLine > insertLine + 1) {
								break;
							}
							endLine++;
						}
						editor.replaceRange(vtableBlock, { line: insertLine + 1, ch: 0 }, { line: endLine, ch: 3 });
					} else {
						editor.replaceRange(vtableBlock, { line: insertLine, ch: editor.getLine(insertLine).length });
					}
					return;
				}
			}

			// Fallback: Vault API
			console.log(`[Execute Code] Using Vault API for persistence (fallback)`);
			const file = this.app.vault.getAbstractFileByPath(this.srcFile);
			if (!file) return;

			const content = await this.app.vault.read(file as any);
			const lines = content.split('\n');
			const codeBlockEnd = this.findCodeBlockEndLine(content);

			if (codeBlockEnd === -1) return;

			let existingVTableEnd = -1;
			let i = codeBlockEnd + 1;
			while (i < lines.length && lines[i].trim() === '') i++;
			if (i < lines.length && lines[i].trim() === '```vtable') {
				for (let k = i + 1; k < lines.length; k++) {
					if (lines[k].trim() === '```') {
						existingVTableEnd = k;
						break;
					}
				}
				if (existingVTableEnd !== -1) {
					const before = lines.slice(0, codeBlockEnd + 1).join('\n');
					const after = lines.slice(existingVTableEnd + 1).join('\n');
					await this.app.vault.modify(file as any, before + vtableBlock + (after ? '\n' + after : ''));
					return;
				}
			}

			const before = lines.slice(0, codeBlockEnd + 1).join('\n');
			const after = lines.slice(codeBlockEnd + 1).join('\n');
			await this.app.vault.modify(file as any, before + vtableBlock + (after ? '\n' + after : ''));

		} catch (e) {
			console.error('[Execute Code] Failed to persist SQL result:', e);
		}
	}

	/**
	 * Helper to find the end line index of the relevant code block.
	 */
	private findCodeBlockEndLine(content: string): number {
		const lines = content.split('\n');
		const srcText = this.codeBlockElement.textContent || '';
		const firstLine = srcText.trim().split('\n').find(l => l.trim().length > 0) || '';

		let occurrencesFound = 0;
		for (let i = 0; i < lines.length; i++) {
			// Support standard sql and run-sql
			if (lines[i].trim().match(/^```\s*(run-)?sql/i)) {
				let j = i + 1;
				let found = false;
				while (j < lines.length && !lines[j].trim().startsWith('```')) {
					if (firstLine && lines[j].includes(firstLine.trim())) found = true;
					j++;
				}
				if (found || !firstLine) {
					if (occurrencesFound === this.blockIndex) return j;
					occurrencesFound++;
				}
			}
		}
		return -1;
	}

	/**
	 * Render parsed SQL data as a VTable.
	 */
	private renderSqlVTable(data: SqlResultData) {
		// Ensure output infrastructure exists
		if (!this.clearButton) this.addClearButton();
		if (!this.outputElement) this.addOutputElement();

		this.outputElement.style.display = "block";
		this.clearButton.className = "clear-button";
		this.hadPreviouslyPrinted = true;

		// Create SQL table container
		this.sqlTableContainer = document.createElement('div');
		this.sqlTableContainer.className = 'sql-vtable-wrapper';

		// Insert before input element if it exists, else append
		if (this.inputElement) {
			this.outputElement.insertBefore(this.sqlTableContainer, this.inputElement);
		} else {
			this.outputElement.appendChild(this.sqlTableContainer);
		}

		// Detect dark mode
		const isDarkMode = document.body.classList.contains('theme-dark');

		// Render the table
		renderSqlTable(data, this.sqlTableContainer, isDarkMode);
	}

	/**
	 * Render SQL result from persisted JSON data.
	 * Used when restoring results from a saved note.
	 */
	renderSqlFromPersistedData(data: SqlResultData) {
		this.renderSqlVTable(data);
	}


	/**
	 * Add an icon to the outputter.
	 * @param icon Name of the icon from the lucide library {@link https://lucide.dev/}
	 * @param hoverTooltip Title to display on mouseover
	 * @param styleClass CSS class for design tweaks
	 * @returns HTMLAnchorElement to add a click listener, for instance
	 */
	writeIcon(icon: string, hoverTooltip?: string, styleClass?: string | string[]): HTMLAnchorElement {
		const button: HTMLAnchorElement = this.lastPrintElem.createEl('a', { title: hoverTooltip, cls: styleClass });
		setIcon(button, icon);
		return button;
	}

	/**
	 * Add a segment of rendered markdown to the outputter
	 * @param markdown The Markdown source code to be rendered as HTML
	 * @param addLineBreak whether to start a new line in stdout afterwards
	 * @param relativeFile Path of the markdown file. Used to resolve relative internal links.
	 */
	async writeMarkdown(markdown: string, addLineBreak?: boolean, relativeFile = this.srcFile) {
		if (relativeFile !== this.srcFile) {
			relativeFile = normalizePath(relativeFile);
		}
		const renderedEl = document.createElement("div");
		await MarkdownRenderer.render(this.app, markdown, renderedEl, relativeFile, new Component());
		for (const child of Array.from(renderedEl.children)) {
			this.write(TOGGLE_HTML_SIGIL + child.innerHTML + TOGGLE_HTML_SIGIL);
		}
		if (addLineBreak) this.write(`\n`);
	}

	/**
	 * Add a segment of stdout data to the outputter,
	 * processing `toggleHtmlSigil`s along the way.
	 * `toggleHtmlSigil`s may be interleaved with text and HTML
	 * in any way; this method will correctly interpret them.
	 * @param text The stdout data in question
	 */
	private processSigilsAndWriteText(text: string) {
		//Loop around, removing HTML toggling sigils
		while (true) {
			let index = text.indexOf(TOGGLE_HTML_SIGIL);
			if (index === -1) break;

			if (index > 0) this.writeRaw(text.substring(0, index));

			this.escapeHTML = !this.escapeHTML;
			this.writeHTMLBuffer(this.addStdout());

			text = text.substring(index + TOGGLE_HTML_SIGIL.length);
		}
		this.writeRaw(text);
	}

	/**
	 * Writes a segment of stdout data without caring about the HTML sigil
	 * @param text The stdout data in question
	 */
	private writeRaw(text: string) {
		//remove ANSI escape codes
		text = text.replace(/\x1b\\[;\d]*m/g, "")

		// Keep output field and clear button invisible if no text was printed.
		if (this.textPrinted(text)) {

			// make visible again:
			this.makeOutputVisible();
		}

		this.escapeAwareAppend(this.addStdout(), text);
	}

	/**
	 * Add a segment of stderr data to the outputter
	 * @param text The stderr data in question
	 */
	writeErr(text: string) {
		//remove ANSI escape codes
		text = text.replace(/\x1b\\[;\d]*m/g, "")

		// Keep output field and clear button invisible if no text was printed.
		if (this.textPrinted(text)) {
			// make visible again:
			this.makeOutputVisible()
		}

		this.addStderr().appendText(text);

	}

	/**
	 * Hide the input element. Stop accepting input from the user.
	 */
	closeInput() {
		this.inputState = "CLOSED";
		if (this.inputElement)
			this.inputElement.style.display = "none";
	}

	/**
	 * Mark the block as running
	 */
	startBlock() {
		if (!this.loadStateIndicatorElement) this.addLoadStateIndicator();
		setTimeout(() => {
			if (this.blockRunState !== "FINISHED")
				this.loadStateIndicatorElement.classList.add("visible");
		}, 100);


		this.loadStateIndicatorElement.empty();
		this.loadStateIndicatorElement.appendChild(loadSpinner());

		this.loadStateIndicatorElement.setAttribute("aria-label", "This block is running.\nClick to stop.");

		this.blockRunState = "RUNNING";
	}

	/**
	 * Marks the block as queued, but waiting for another block before running
	 */
	queueBlock() {
		if (!this.loadStateIndicatorElement) this.addLoadStateIndicator();
		setTimeout(() => {
			if (this.blockRunState !== "FINISHED")
				this.loadStateIndicatorElement.classList.add("visible");
		}, 100);

		this.loadStateIndicatorElement.empty();
		this.loadStateIndicatorElement.appendChild(loadEllipses());

		this.loadStateIndicatorElement.setAttribute("aria-label", "This block is waiting for another block to finish.\nClick to cancel.");

		this.blockRunState = "QUEUED";
	}

	/** Marks the block as finished running */
	finishBlock() {
		if (this.loadStateIndicatorElement) {
			this.loadStateIndicatorElement.classList.remove("visible");
		}

		this.blockRunState = "FINISHED";
	}

	private addLoadStateIndicator() {
		this.loadStateIndicatorElement = document.createElement("div");

		this.loadStateIndicatorElement.classList.add("load-state-indicator");

		// Kill code block on clicking load state indicator
		this.loadStateIndicatorElement.addEventListener('click', () => this.killBlock(this.runningSubprocesses));

		this.getParentElement().parentElement.appendChild(this.loadStateIndicatorElement);
	}

	private getParentElement() {
		return this.codeBlockElement.parentElement as HTMLDivElement;
	}

	private addClearButton() {
		const parentEl = this.getParentElement();

		this.clearButton = document.createElement("button");
		this.clearButton.className = "clear-button";
		this.clearButton.setText("Clear");
		this.clearButton.addEventListener("click", () => this.delete());

		parentEl.appendChild(this.clearButton);
	}

	private addOutputElement() {
		const parentEl = this.getParentElement();

		const hr = document.createElement("hr");

		this.outputElement = document.createElement("code");
		this.outputElement.classList.add("language-output");

		// TODO: Additionally include class executor-output?
		// this.outputElement.classList.add("executor-output");

		this.outputElement.appendChild(hr);
		if (this.inputState != "NOT_DOING") this.addInputElement();
		parentEl.appendChild(this.outputElement);
	}

	/**
	 * Add an interactive input element to the outputter
	 */
	private addInputElement() {
		this.inputElement = document.createElement("input");
		this.inputElement.classList.add("interactive-stdin");
		this.inputElement.addEventListener("keypress", (e) => {
			if (e.key == "Enter") {
				this.processInput(this.inputElement.value + "\n");
				this.inputElement.value = "";
			}
		})


		this.outputElement.appendChild(this.inputElement);
	}

	/**
	 * Ensure that input from a user gets echoed to the outputter before being emitted to event subscribers.
	 *
	 * @param input a line of input from the user. In most applications, should end with a newline.
	 */
	private processInput(input: string) {
		this.addStdin().appendText(input);

		this.emit("data", input);
	}

	private addStdin(): HTMLSpanElement {
		return this.addStreamSegmentElement("stdin");
	}

	private addStderr(): HTMLSpanElement {
		return this.addStreamSegmentElement("stderr");
	}

	private addStdout(): HTMLSpanElement {
		return this.addStreamSegmentElement("stdout");
	}

	/**
	 * Creates a wrapper element for a segment of a standard stream.
	 * In order to intermingle the streams as they are output to, segments
	 * are more effective than one-element-for-each.
	 *
	 * If the last segment was of the same stream, it will be returned instead.
	 *
	 * @param streamId The standard stream's name (stderr, stdout, or stdin)
	 * @returns the wrapper `span` element
	 */
	private addStreamSegmentElement(streamId: "stderr" | "stdout" | "stdin"): HTMLSpanElement {
		if (!this.outputElement) this.addOutputElement();

		if (this.lastPrintElem)
			if (this.lastPrintElem.classList.contains(streamId)) return this.lastPrintElem;

		const stdElem = document.createElement("span");
		stdElem.addClass(streamId);

		if (this.inputElement) {
			this.outputElement.insertBefore(stdElem, this.inputElement);
		} else {
			this.outputElement.appendChild(stdElem);
		}
		this.lastPrintElem = stdElem;

		return stdElem
	}

	/**
	 * Appends some text to a given element. Respects `this.escapeHTML` for whether or not to escape HTML.
	 * If not escaping HTML, appends the text to the HTML buffer to ensure that the whole HTML segment is recieved
	 * before parsing it.
	 * @param element Element to append to
	 * @param text text to append
	 */
	private escapeAwareAppend(element: HTMLElement, text: string) {
		if (this.escapeHTML) {
			// If we're escaping HTML, just append the text
			element.appendChild(document.createTextNode(text));

			if (this.settings.persistentOuput) {
				// Also append to file in separate code block
				this.saveToFile.addOutput(text);
			}

		} else {
			this.htmlBuffer += text;
		}
	}

	/**
	 * Parses the HTML buffer and appends its elements to a given parent element.
	 * Erases the HTML buffer afterwards.
	 * @param element element to append to
	 */
	private writeHTMLBuffer(element: HTMLElement) {
		if (this.htmlBuffer !== "") {
			this.makeOutputVisible();

			const content = document.createElement("div");
			content.innerHTML = this.htmlBuffer;
			for (const childElem of Array.from(content.childNodes))
				element.appendChild(childElem);

			// TODO: Include to file output,
			// this.saveToFile.addOutput(this.htmlBuffer);

			this.htmlBuffer = "";
		}
	}

	/**
	 * Checks if either:
	 * - this outputter has printed something before.
	 * - the given `text` is non-empty.
	 * If `text` is non-empty, this function will assume that it gets printed later.
	 *
	 * @param text Text which is to be printed
	 * @returns Whether text has been printed or will be printed
	 */
	private textPrinted(text: string) {
		if (this.hadPreviouslyPrinted) return true;

		if (text.contains(TOGGLE_HTML_SIGIL)) return false;
		if (text === "") return false;

		this.hadPreviouslyPrinted = true;
		return true;
	}

	/**
	 * Restores output elements after the outputter has been `delete()`d or `clear()`d.
	 * @see {@link delete()}
	 * @see {@link clear()}
	 */
	private makeOutputVisible() {
		this.closeInput();
		if (!this.clearButton) this.addClearButton();
		if (!this.outputElement) this.addOutputElement();

		this.inputState = "OPEN";
		this.outputElement.style.display = "block";
		this.clearButton.className = "clear-button";

		setTimeout(() => {
			if (this.inputState === "OPEN") this.inputElement.style.display = "inline";
		}, 1000)
	}
}
