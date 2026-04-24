import { App, Workspace, MarkdownView, MarkdownPostProcessorContext } from 'obsidian';
import ExecutorContainer from './ExecutorContainer';
import { LanguageId, PluginContext, supportedLanguages } from './main';
import { Outputter } from './output/Outputter';
import type { ExecutorSettings } from './settings/Settings';
import { CodeInjector } from './transforms/CodeInjector';
import { retrieveFigurePath } from './transforms/LatexFigureName';
import { modifyLatexCode } from './transforms/LatexTransformer';
import * as macro from './transforms/Magic';
import { getLanguageAlias } from './transforms/TransformCode';

const buttonText = "Run";

export const buttonClass: string = "run-code-button";
export const disabledClass: string = "run-button-disabled";
export const codeBlockHasButtonClass: string = "has-run-code-button";

interface CodeBlockContext {
    srcCode: string;
    button: HTMLButtonElement;
    language: LanguageId;
    markdownFile: string;
    outputter: Outputter;
    executors: ExecutorContainer;
}

/**
 * Handles the execution of code blocks based on the selected programming language.
 * Injects any required code, transforms the source if needed, and manages button state.
 * @param block Contains context needed for execution including source code, output handler, and UI elements
 */
async function handleExecution(block: CodeBlockContext) {
    const language: LanguageId = block.language;
    const button: HTMLButtonElement = block.button;
    const srcCode: string = block.srcCode;
    const app: App = block.outputter.app;
    const s: ExecutorSettings = block.outputter.settings;

    button.className = disabledClass;
    block.srcCode = await new CodeInjector(app, s, language).injectCode(srcCode);

    switch (language) {
        case "js": return runCode(s.nodePath, s.nodeArgs, s.jsFileExtension, block, { transform: (code) => macro.expandJS(code) });
        case "java": return runCode(s.javaPath, s.javaArgs, s.javaFileExtension, block);
        case "python": return runCode(s.pythonPath, s.pythonArgs, s.pythonFileExtension, block, { transform: (code) => macro.expandPython(code, s) });
        case "shell": return runCode(s.shellPath, s.shellArgs, s.shellFileExtension, block, { shell: true });
        case "batch": return runCode(s.batchPath, s.batchArgs, s.batchFileExtension, block, { shell: true });
        case "powershell": return runCode(s.powershellPath, s.powershellArgs, s.powershellFileExtension, block, { shell: true });
        case "cpp": return runCode(s.clingPath, `-std=${s.clingStd} ${s.clingArgs}`, s.cppFileExtension, block);
        case "prolog":
            runCode("", "", "", block);
            button.className = buttonClass;
            break;
        case "groovy": return runCode(s.groovyPath, s.groovyArgs, s.groovyFileExtension, block, { shell: true });
        case "rust": return runCode(s.cargoPath, "eval" + s.cargoEvalArgs, s.rustFileExtension, block);
        case "r": return runCode(s.RPath, s.RArgs, s.RFileExtension, block, { transform: (code) => macro.expandRPlots(code) });
        case "go": return runCode(s.golangPath, s.golangArgs, s.golangFileExtension, block);
        case "kotlin": return runCode(s.kotlinPath, s.kotlinArgs, s.kotlinFileExtension, block, { shell: true });
        case "ts": return runCode(s.tsPath, s.tsArgs, "ts", block, { shell: true });
        case "lua": return runCode(s.luaPath, s.luaArgs, s.luaFileExtension, block, { shell: true });
        case "dart": return runCode(s.dartPath, s.dartArgs, s.dartFileExtension, block, { shell: true });
        case "cs": return runCode(s.csPath, s.csArgs, s.csFileExtension, block, { shell: true });
        case "haskell": return (s.useGhci)
            ? runCode(s.ghciPath, "", "hs", block, { shell: true })
            : runCode(s.runghcPath, "-f " + s.ghcPath, "hs", block, { shell: true });
        case "mathematica": return runCode(s.mathematicaPath, s.mathematicaArgs, s.mathematicaFileExtension, block, { shell: true });
        case "scala": return runCode(s.scalaPath, s.scalaArgs, s.scalaFileExtension, block, { shell: true });
        case "swift": return runCode(s.swiftPath, s.swiftArgs, s.swiftFileExtension, block, { shell: true });
        case "c": return runCode(s.clingPath, s.clingArgs, "c", block, { shell: true });
        case "ruby": return runCode(s.rubyPath, s.rubyArgs, s.rubyFileExtension, block, { shell: true });
        case "sql": return runCode(s.sqlPath, s.sqlArgs, "sql", block, { shell: true });
        case "octave": return runCode(s.octavePath, s.octaveArgs, s.octaveFileExtension, block, { shell: true, transform: (code) => macro.expandOctavePlot(code) });
        case "maxima": return runCode(s.maximaPath, s.maximaArgs, s.maximaFileExtension, block, { shell: true, transform: (code) => macro.expandMaximaPlot(code) });
        case "racket": return runCode(s.racketPath, s.racketArgs, s.racketFileExtension, block, { shell: true });
        case "applescript": return runCode(s.applescriptPath, s.applescriptArgs, s.applescriptFileExtension, block, { shell: true });
        case "zig": return runCode(s.zigPath, s.zigArgs, "zig", block, { shell: true });
        case "ocaml": return runCode(s.ocamlPath, s.ocamlArgs, "ocaml", block, { shell: true });
        case "php": return runCode(s.phpPath, s.phpArgs, s.phpFileExtension, block, { shell: true });
        case "latex":
            const outputPath: string = await retrieveFigurePath(block.srcCode, s.latexFigureTitlePattern, block.markdownFile, s);
            const invokeCompiler: string = [s.latexTexfotArgs, s.latexCompilerPath, s.latexCompilerArgs].join(" ");
            return (!s.latexDoFilter)
                ? runCode(s.latexCompilerPath, s.latexCompilerArgs, outputPath, block, { transform: (code) => modifyLatexCode(code, s) })
                : runCode(s.latexTexfotPath, invokeCompiler, outputPath, block, { transform: (code) => modifyLatexCode(code, s) });
        default: break;
    }
}

/**
 * Adds run buttons to code blocks in all currently open Markdown files.
 * More efficient than scanning entire documents since it only processes visible content.
 * @param plugin Contains context needed for execution.
 */
export function addInOpenFiles(plugin: PluginContext) {
    const workspace: Workspace = plugin.app.workspace;
    workspace.iterateRootLeaves(leaf => {
        if (leaf.view instanceof MarkdownView) {
            addToAllCodeBlocks(leaf.view.contentEl, leaf.view.file.path, leaf.view, plugin);
        }
    });
}

/**
 * Add a button to each code block that allows the user to run the code. The button is only added if the code block
 * utilizes a language that is supported by this plugin.
 * @param element The parent element (i.e. the currently showed html page / note).
 * @param file An identifier for the currently showed note
 * @param view The current markdown view
 * @param plugin Contains context needed for execution.
 * @param context The post-processor context.
*/
export function addToAllCodeBlocks(
    element: HTMLElement,
    file: string,
    view: MarkdownView,
    plugin: PluginContext,
    context?: MarkdownPostProcessorContext
) {
    const codeBlocks = Array.from(element.getElementsByTagName("code"));
    codeBlocks.forEach((codeBlock: HTMLElement, index: number) => {
        addToCodeBlock(
            element, codeBlock, file, view, plugin, context,
            index
        );
    });
}

/**
 * Processes a code block to add execution capabilities. Ensures buttons aren't duplicated on already processed blocks.
 * @param element The parent section element
 * @param codeBlock The code block element to process
 * @param file Path to the current markdown file
 * @param view The current markdown view
 * @param plugin Contains context needed for execution.
 * @param context The post-processor context.
 * @param blockIndex The index of the code block in the current processing context.
 */
function addToCodeBlock(element: HTMLElement, codeBlock: HTMLElement, file: string, view: MarkdownView, plugin: PluginContext, context: MarkdownPostProcessorContext,
    blockIndex: number = 0
) {
    if (codeBlock.className.match(/^language-\{\w+/i)) {
        codeBlock.className = codeBlock.className.replace(/^language-\{(\w+)/i, "language-$1 {");
        codeBlock.parentElement.className = codeBlock.className;
    }

    const language = codeBlock.className.toLowerCase();

    if (!language || !language.contains("language-"))
        return;

    const pre = codeBlock.parentElement as HTMLPreElement;
    const parent = pre.parentElement as HTMLDivElement;

    const srcCode = codeBlock.getText();
    let sanitizedClassList = sanitizeClassListOfCodeBlock(codeBlock);

    const canonicalLanguage = getLanguageAlias(
        supportedLanguages.find(lang => sanitizedClassList.contains(`language-${lang}`))
    ) as LanguageId;

    const isLanguageSupported: Boolean = canonicalLanguage !== undefined;
    const hasBlockBeenButtonifiedAlready = parent.classList.contains(codeBlockHasButtonClass);
    if (!isLanguageSupported || hasBlockBeenButtonifiedAlready) return;

    const sectionInfo = context ? context.getSectionInfo(element) : null;
    const sectionStartLine = sectionInfo ? sectionInfo.lineStart : 0;

    // Find index of this specific code block within its section
    const blocksInSection = Array.from(element.querySelectorAll('code[class*="language-"]'));
    const relativeIndex = blocksInSection.indexOf(codeBlock);

    const outputter = new Outputter(
        codeBlock, plugin.settings, view, plugin.app, file, canonicalLanguage,
        context, sectionStartLine, relativeIndex
    );
    parent.classList.add(codeBlockHasButtonClass);

    // Create toolbar container at top-right with Copy + Run buttons
    const toolbar = document.createElement('div');
    toolbar.className = 'code-block-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-toolbar-btn code-copy-btn';
    copyBtn.title = 'Copy code';
    copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(srcCode).then(() => {
            copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => {
                copyBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            }, 1500);
        });
    });

    const button = createButton();

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(button);
    pre.appendChild(toolbar);

    const block: CodeBlockContext = {
        srcCode: srcCode,
        language: canonicalLanguage,
        markdownFile: file,
        button: button,
        outputter: outputter,
        executors: plugin.executors,
    };

    button.addEventListener("click", () => handleExecution(block));
}

/**
 * Normalizes language class names to ensure consistent processing.
 * @param codeBlock - The code block element whose classes need to be sanitized
 * @returns Array of normalized class names
 */
function sanitizeClassListOfCodeBlock(codeBlock: HTMLElement) {
    let sanitizedClassList = Array.from(codeBlock.classList);
    return sanitizedClassList.map(c => c.toLowerCase());
}

/**
 * Creates a new run button and returns it.
 */
function createButton(): HTMLButtonElement {
    console.debug("Add run button");
    const button = document.createElement("button");
    button.classList.add(buttonClass);
    button.setText(buttonText);
    return button;
}

/**
 * Executes the code with the given command and arguments. The code is written to a temporary file and then executed.
 * The output of the code is displayed in the output panel ({@link Outputter}).
 * If the code execution fails, an error message is displayed and logged.
 * After the code execution, the temporary file is deleted and the run button is re-enabled.
 * @param cmd The command that should be used to execute the code. (e.g. python, java, ...)
 * @param cmdArgs Additional arguments that should be passed to the command.
 * @param ext The file extension of the temporary file. Should correspond to the language of the code. (e.g. py, ...)
 * @param block Contains context needed for execution including source code, output handler, and UI elements
 */
function runCode(cmd: string, cmdArgs: string, ext: string, block: CodeBlockContext, options?: { shell?: boolean; transform?: (code: string) => string; }) {
    const useShell: boolean = (options?.shell) ? options.shell : false;
    if (options?.transform) block.srcCode = options.transform(block.srcCode);
    if (!useShell) block.outputter.startBlock();

    const executor = block.executors.getExecutorFor(block.markdownFile, block.language, useShell);
    executor.run(block.srcCode, block.outputter, cmd, cmdArgs, ext).then(() => {
        block.button.className = buttonClass;
        if (!useShell) {
            block.outputter.closeInput();
            block.outputter.finishBlock();
        }

        // For SQL, finalize the output to render VTable
        if (block.language === 'sql') {
            block.outputter.finalizeSqlOutput();
        }
    });
}
