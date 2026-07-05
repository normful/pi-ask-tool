import { Key, matchesKey, type MarkdownTheme } from "@mariozechner/pi-tui";

// ── Render cache ──────────────────────────────────────────────────────────

export interface RenderCache {
	cachedRenderedLines: string[] | undefined;
	cachedRenderedWidth: number | undefined;
}

export function createRenderCache(): RenderCache {
	return {
		cachedRenderedLines: undefined,
		cachedRenderedWidth: undefined,
	};
}

export function requestRerender(
	tui: { requestRender(): void },
	cache: RenderCache,
): void {
	cache.cachedRenderedLines = undefined;
	cache.cachedRenderedWidth = undefined;
	tui.requestRender();
}

// ── Markdown theme ────────────────────────────────────────────────────────

interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	strikethrough(text: string): string;
	underline(text: string): string;
}

export function createMarkdownTheme(theme: ThemeLike): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

// ── User alert ────────────────────────────────────────────────────────────

export function alertUserOnce(alerted: { value: boolean }): void {
	if (alerted.value) return;
	alerted.value = true;
	process.stdout.write("\x07");
	process.stdout.write("\x1b]777;notify;Pi Ask;Questions awaiting your answer\x07");
}

// ── Note editor key handling ──────────────────────────────────────────────

interface NoteEditorLike {
	setText(text: string): void;
	handleInput(data: string): void;
}

/**
 * Handle key events when the inline note editor is open.
 * Manages Tab/Escape (close editor), F7 (clear text), and normal editing.
 * @returns true (caller should return after calling this)
 */
export function handleNoteEditorInput(
	data: string,
	noteEditor: NoteEditorLike,
	callbacks: {
		onCloseEditor: () => void;
		requestRerender: () => void;
	},
): true {
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
		callbacks.onCloseEditor();
		callbacks.requestRerender();
		return true;
	}
	if (matchesKey(data, Key.f7)) {
		noteEditor.setText("");
		callbacks.requestRerender();
		return true;
	}
	noteEditor.handleInput(data);
	callbacks.requestRerender();
	return true;
}
