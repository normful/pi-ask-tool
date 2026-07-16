import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Editor, Markdown, type EditorTheme, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	OTHER_OPTION,
	appendRecommendedTagToOptionLabels,
	buildSingleSelectionResult,
	type AskOption,
	type AskSelection,
} from "./ask-logic";
import { getLinearCursorIndexFromEditor } from "./ask-inline-editor-cursor";
import { INLINE_NOTE_WRAP_PADDING, buildWrappedOptionLabelWithInlineNote } from "./ask-inline-note";
import {
	alertUserOnce,
	createMarkdownTheme,
	createRenderCache,
	handleNoteEditorInput,
	requestRerender,
} from "./ask-ui-shared";

interface SingleQuestionInput {
	question: string;
	markdownCtx?: string;
	options: AskOption[];
	recommended?: number;
}

interface InlineSelectionResult {
	cancelled: boolean;
	selectedOption?: string;
	note?: string;
}

function resolveInitialCursorIndexFromRecommendedOption(
	recommendedOptionIndex: number | undefined,
	optionCount: number,
): number {
	if (recommendedOptionIndex == null) return 0;
	if (recommendedOptionIndex < 0 || recommendedOptionIndex >= optionCount) return 0;
	return recommendedOptionIndex;
}

export async function askSingleQuestionWithInlineNote(
	ui: ExtensionUIContext,
	questionInput: SingleQuestionInput,
): Promise<AskSelection> {
	const baseOptionLabels = questionInput.options.map((option) => option.label);
	const optionLabelsWithRecommendedTag = appendRecommendedTagToOptionLabels(
		baseOptionLabels,
		questionInput.recommended,
	);
	const selectableOptionLabels = [...optionLabelsWithRecommendedTag, OTHER_OPTION];
	const initialCursorIndex = resolveInitialCursorIndexFromRecommendedOption(
		questionInput.recommended,
		optionLabelsWithRecommendedTag.length,
	);

	const result = await ui.custom<InlineSelectionResult>((tui, theme, _keybindings, done) => {
		let cursorOptionIndex = initialCursorIndex;
		let isNoteEditorOpen = false;
		const cache = createRenderCache();
		const alerted = { value: false };
		const noteByOptionIndex = new Map<number, string>();

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const noteEditor = new Editor(tui, editorTheme);
		const markdownTheme = createMarkdownTheme(theme);
		const questionDescriptionMarkdown =
			questionInput.markdownCtx && questionInput.markdownCtx.trim().length > 0
				? new Markdown(questionInput.markdownCtx, 0, 0, markdownTheme, {
						color: (text) => theme.fg("muted", text),
					})
				: undefined;

		const rerender = () => requestRerender(tui, cache);

		const getRawNoteForOption = (optionIndex: number): string => noteByOptionIndex.get(optionIndex) ?? "";
		const getTrimmedNoteForOption = (optionIndex: number): string => getRawNoteForOption(optionIndex).trim();

		const loadCurrentNoteIntoEditor = () => {
			noteEditor.setText(getRawNoteForOption(cursorOptionIndex));
		};

		const saveCurrentNoteFromEditor = (value: string) => {
			noteByOptionIndex.set(cursorOptionIndex, value);
		};

		const submitCurrentSelection = (selectedOptionLabel: string, note: string) => {
			done({
				cancelled: false,
				selectedOption: selectedOptionLabel,
				note,
			});
		};

		noteEditor.onChange = (value) => {
			saveCurrentNoteFromEditor(value);
		};

		noteEditor.onSubmit = (value) => {
			saveCurrentNoteFromEditor(value);
			const selectedOptionLabel = selectableOptionLabels[cursorOptionIndex];
			const trimmedNote = value.trim();

			if (selectedOptionLabel === OTHER_OPTION && !trimmedNote) {
				rerender();
				return;
			}

			submitCurrentSelection(selectedOptionLabel, trimmedNote);
		};

		const render = (width: number): string[] => {
			if (cache.cachedRenderedLines && cache.cachedRenderedWidth === width) return cache.cachedRenderedLines;

			const renderedLines: string[] = [];
			const addLine = (line: string) => renderedLines.push(truncateToWidth(line, width));

			alertUserOnce(alerted);

			addLine(theme.fg("accent", "─".repeat(width)));
			const questionLines = new Markdown(questionInput.question, 0, 0, markdownTheme, {
				color: (text) => theme.fg("text", text),
			}).render(Math.max(1, width - 1));
			for (const line of questionLines) {
				addLine(` ${line}`);
			}
			if (questionDescriptionMarkdown) {
				renderedLines.push("");
				const descriptionLines = questionDescriptionMarkdown.render(Math.max(1, width - 1));
				for (const descriptionLine of descriptionLines) {
					addLine(` ${descriptionLine}`);
				}
			}
			renderedLines.push("");

			const activeEditingCursorIndex = isNoteEditorOpen
				? getLinearCursorIndexFromEditor(noteEditor)
				: undefined;
			for (let optionIndex = 0; optionIndex < selectableOptionLabels.length; optionIndex++) {
				const optionLabel = selectableOptionLabels[optionIndex];
				const isCursorOption = optionIndex === cursorOptionIndex;
				const isEditingThisOption = isNoteEditorOpen && isCursorOption;
				const cursorPrefixText = isCursorOption ? "→ " : "  ";
				const cursorPrefix = isCursorOption ? theme.fg("accent", cursorPrefixText) : cursorPrefixText;
				const bullet = isCursorOption ? "●" : "○";
				const markerText = `${bullet} `;
				const optionColor = isCursorOption ? "accent" : "text";
				const prefixWidth = visibleWidth(cursorPrefixText) + visibleWidth(markerText);
				// Render option label as Markdown when idle (editing shows plain text so cursor math works)
				const displayLabel =
					!isEditingThisOption && optionLabel.length > 0
						? new Markdown(optionLabel, 0, 0, markdownTheme).render(Math.max(1, width)).join("\n")
						: optionLabel;
				const wrappedInlineLabelLines = buildWrappedOptionLabelWithInlineNote(
					displayLabel,
					getRawNoteForOption(optionIndex),
					isEditingThisOption,
					Math.max(1, width - prefixWidth),
					INLINE_NOTE_WRAP_PADDING,
					isEditingThisOption ? activeEditingCursorIndex : undefined,
				);
				const continuationPrefix = " ".repeat(prefixWidth);
				addLine(`${cursorPrefix}${theme.fg(optionColor, `${markerText}${wrappedInlineLabelLines[0] ?? ""}`)}`);
				for (const wrappedLine of wrappedInlineLabelLines.slice(1)) {
					addLine(`${continuationPrefix}${theme.fg(optionColor, wrappedLine)}`);
				}
			}

			renderedLines.push("");

			if (isNoteEditorOpen) {
				addLine(theme.fg("dim", " Typing note inline • Enter submit • Tab/Esc stop editing • F7 clear text"));
			} else if (getTrimmedNoteForOption(cursorOptionIndex).length > 0) {
				addLine(theme.fg("dim", " ↑↓ move • Enter submit • Tab edit note • F6 exit entirely"));
			} else {
				addLine(theme.fg("dim", " ↑↓ move • Enter submit • Tab add note • F6 exit entirely"));
			}

			addLine(theme.fg("accent", "─".repeat(width)));
			cache.cachedRenderedLines = renderedLines;
			cache.cachedRenderedWidth = width;
			return renderedLines;
		};

		const handleInput = (data: string) => {
			if (matchesKey(data, Key.ctrl("c"))) {
				done({ cancelled: true });
				return;
			}

			if (isNoteEditorOpen) {
				handleNoteEditorInput(data, noteEditor, {
					onCloseEditor: () => {
						isNoteEditorOpen = false;
					},
					requestRerender: rerender,
				});
				return;
			}

			if (matchesKey(data, Key.up)) {
				cursorOptionIndex = Math.max(0, cursorOptionIndex - 1);
				rerender();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursorOptionIndex = Math.min(selectableOptionLabels.length - 1, cursorOptionIndex + 1);
				rerender();
				return;
			}

			if (matchesKey(data, Key.tab)) {
				isNoteEditorOpen = true;
				loadCurrentNoteIntoEditor();
				rerender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				const selectedOptionLabel = selectableOptionLabels[cursorOptionIndex];
				const trimmedNote = getTrimmedNoteForOption(cursorOptionIndex);

				if (selectedOptionLabel === OTHER_OPTION && !trimmedNote) {
					isNoteEditorOpen = true;
					loadCurrentNoteIntoEditor();
					rerender();
					return;
				}

				submitCurrentSelection(selectedOptionLabel, trimmedNote);
				return;
			}

			if (matchesKey(data, Key.f6)) {
				done({ cancelled: true });
			}
		};

		return {
			render,
			invalidate: () => {
				cache.cachedRenderedLines = undefined;
				cache.cachedRenderedWidth = undefined;
			},
			handleInput,
		};
	});

	if (result.cancelled || !result.selectedOption) {
		return { selectedOptions: [] };
	}

	return buildSingleSelectionResult(result.selectedOption, result.note);
}
