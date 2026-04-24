import { App, Component, MarkdownRenderer, MarkdownView, Plugin, } from 'obsidian';
import type { SqlResultData } from './output/SqlResultParser';
import { renderSqlTable, destroySqlTable } from './output/SqlTableRenderer';

import type { ExecutorSettings } from "./settings/Settings";
import { DEFAULT_SETTINGS } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { applyLatexBodyClasses } from "./transforms/LatexTransformer"

import ExecutorContainer from './ExecutorContainer';
import ExecutorManagerView, {
	EXECUTOR_MANAGER_OPEN_VIEW_COMMAND_ID,
	EXECUTOR_MANAGER_VIEW_ID
} from './ExecutorManagerView';

import runAllCodeBlocks from './runAllCodeBlocks';
import { ReleaseNoteModel } from "./ReleaseNoteModal";
import * as runButton from './RunButton';

export const languageAliases = ["javascript", "typescript", "bash", "csharp", "wolfram", "nb", "wl", "hs", "py", "tex"] as const;
export const canonicalLanguages = ["js", "ts", "cs", "latex", "lean", "lua", "python", "cpp", "prolog", "shell", "groovy", "r",
	"go", "rust", "java", "powershell", "kotlin", "mathematica", "haskell", "scala", "swift", "racket", "fsharp", "c", "dart",
	"ruby", "batch", "sql", "octave", "maxima", "applescript", "zig", "ocaml", "php"] as const;
export const supportedLanguages = [...languageAliases, ...canonicalLanguages] as const;
export type LanguageId = typeof canonicalLanguages[number];

export interface PluginContext {
	app: App;
	settings: ExecutorSettings;
	executors: ExecutorContainer;
}

export default class ExecuteCodePlugin extends Plugin {
	settings: ExecutorSettings;
	executors: ExecutorContainer;

	/**
	 * Preparations for the plugin (adding buttons, html elements and event listeners).
	 */
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		this.executors = new ExecutorContainer(this);

		const context: PluginContext = {
			app: this.app,
			settings: this.settings,
			executors: this.executors,
		}
		runButton.addInOpenFiles(context);
		this.registerMarkdownPostProcessor((element, _context) => {
			runButton.addToAllCodeBlocks(element, _context.sourcePath, this.app.workspace.getActiveViewOfType(MarkdownView), context, _context);
		});

		// Custom VTable block processor for persistence
		this.registerMarkdownCodeBlockProcessor("vtable", (src, el, ctx) => {
			try {
				const data: SqlResultData = JSON.parse(src);
				if (data && data.columns && data.records) {
					const container = el.createDiv({ cls: 'sql-vtable-wrapper' });
					const isDarkMode = document.body.classList.contains('theme-dark');
					
					// Deletion callback for persisted blocks
					const onDelete = async () => {
						const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
						if (activeView && activeView.file && activeView.file.path === ctx.sourcePath) {
							const editor = activeView.editor;
							const section = ctx.getSectionInfo(el);
							if (section) {
								// Delete the block lines
								editor.replaceRange('', 
									{ line: section.lineStart, ch: 0 }, 
									{ line: section.lineEnd + 1, ch: 0 }
								);
								return;
							}
						}
						
						// Fallback: Vault API
						const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
						if (file) {
							const content = await this.app.vault.read(file as any);
							const lines = content.split('\n');
							const section = ctx.getSectionInfo(el);
							if (section) {
								lines.splice(section.lineStart, section.lineEnd - section.lineStart + 1);
								await this.app.vault.modify(file as any, lines.join('\n'));
							}
						}
					};

					renderSqlTable(data, container, isDarkMode, onDelete);
				}
			} catch (e) {
				console.error('Failed to render persisted vtable:', e);
				el.createEl('pre').createEl('code').setText(src);
			}
		});

		// live preview renderers
		supportedLanguages.forEach(l => {
			console.debug(`Registering renderer for ${l}.`)
			this.registerMarkdownCodeBlockProcessor(`run-${l}`, async (src, el, _ctx) => {
				await MarkdownRenderer.render(this.app, '```' + l + '\n' + src + (src.endsWith('\n') ? '' : '\n') + '```', el, _ctx.sourcePath, new Component());
			});
		});

		//executor manager

		this.registerView(
			EXECUTOR_MANAGER_VIEW_ID, (leaf) => new ExecutorManagerView(leaf, this.executors)
		);
		this.addCommand({
			id: EXECUTOR_MANAGER_OPEN_VIEW_COMMAND_ID,
			name: "Open Code Runtime Management",
			callback: () => ExecutorManagerView.activate(this.app.workspace)
		});

		this.addCommand({
			id: "run-all-code-blocks-in-file",
			name: "Run all Code Blocks in Current File",
			callback: () => runAllCodeBlocks(this.app.workspace)
		})

		if (!this.settings.releaseNote2_1_0wasShowed) {
			this.app.workspace.onLayoutReady(() => {
				new ReleaseNoteModel(this.app).open();
			})

			// Set to true to prevent the release note from showing again
			this.settings.releaseNote2_1_0wasShowed = true;
			this.saveSettings();
		}

		applyLatexBodyClasses(this.app, this.settings);
	}

	/**
	 *  Remove all generated html elements (run & clear buttons, output elements) when the plugin is disabled.
	 */
	onunload() {
		document
			.querySelectorAll("pre > code")
			.forEach((codeBlock: HTMLElement) => {
				const pre = codeBlock.parentElement as HTMLPreElement;
				const parent = pre.parentElement as HTMLDivElement;

				if (parent.hasClass(runButton.codeBlockHasButtonClass)) {
					parent.removeClass(runButton.codeBlockHasButtonClass);
				}
			});

		document
			.querySelectorAll("." + runButton.buttonClass)
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll("." + runButton.disabledClass)
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll(".clear-button")
			.forEach((button: HTMLButtonElement) => button.remove());

		document
			.querySelectorAll(".language-output")
			.forEach((out: HTMLElement) => out.remove());

		for (const executor of this.executors) {
			executor.stop().then(_ => { /* do nothing */
			});
		}

		console.log("Unloaded plugin: Execute Code");
	}

	/**
	 * Loads the settings for this plugin from the corresponding save file and stores them in {@link settings}.
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (process.platform !== "win32") {
			this.settings.wslMode = false;
		}
	}

	/**
	 * Saves the settings in {@link settings} to the corresponding save file.
	 */
	async saveSettings() {
		await this.saveData(this.settings);
	}
}