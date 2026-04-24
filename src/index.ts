import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { OTHER_OPTION, type AskQuestion } from "./ask-logic";
import { askSingleQuestionWithInlineNote } from "./ask-inline-ui";
import { askQuestionsWithTabs } from "./ask-tabs-ui";

const OptionItemSchema = Type.Object({
  label: Type.String({}),
});

const QuestionItemSchema = Type.Object({
  id: Type.String({ description: "unique key" }),
  question: Type.String({ description: "prompt" }),
  markdownCtx: Type.Optional(Type.String({ description: "Markdown hint" })),
  options: Type.Array(OptionItemSchema, {
    description: "choices (DO NOT include Other)",
    minItems: 1,
  }),
  multi: Type.Optional(Type.Boolean({ description: "true = multi-select" })),
  recommended: Type.Optional(
    Type.Number({ description: "your recommendation (0-indexed)" }),
  ),
});

const AskParamsSchema = Type.Object({
  questions: Type.Array(QuestionItemSchema, {
    description: "Questions to ask",
    minItems: 1,
  }),
});

type AskParams = Static<typeof AskParamsSchema>;

interface QuestionResult {
  id: string;
  question: string;
  markdownCtx?: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

interface AskToolDetails {
  id?: string;
  question?: string;
  markdownCtx?: string;
  options?: string[];
  multi?: boolean;
  selectedOptions?: string[];
  customInput?: string;
  results?: QuestionResult[];
}

function sanitizeForSessionText(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeMultilineForSessionText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => sanitizeForSessionText(line))
    .join("\n")
    .trim();
}

function sanitizeOptionForSessionText(option: string): string {
  const sanitizedOption = sanitizeForSessionText(option);
  return sanitizedOption.length > 0 ? sanitizedOption : "(empty option)";
}

function toSessionSafeQuestionResult(result: QuestionResult): QuestionResult {
  const selectedOptions = result.selectedOptions
    .map((selectedOption) => sanitizeForSessionText(selectedOption))
    .filter((selectedOption) => selectedOption.length > 0);

  const rawMarkdownCtx = result.markdownCtx;
  const markdownCtx =
    rawMarkdownCtx == null
      ? undefined
      : sanitizeMultilineForSessionText(rawMarkdownCtx);
  const rawCustomInput = result.customInput;
  const customInput =
    rawCustomInput == null ? undefined : sanitizeForSessionText(rawCustomInput);

  return {
    id: sanitizeForSessionText(result.id) || "(unknown)",
    question: sanitizeForSessionText(result.question) || "(empty question)",
    markdownCtx:
      markdownCtx && markdownCtx.length > 0 ? markdownCtx : undefined,
    options: result.options.map(sanitizeOptionForSessionText),
    multi: result.multi,
    selectedOptions,
    customInput:
      customInput && customInput.length > 0 ? customInput : undefined,
  };
}

function formatSelectionForSummary(result: QuestionResult): string {
  const hasSelectedOptions = result.selectedOptions.length > 0;
  const hasCustomInput = Boolean(result.customInput);

  if (!hasSelectedOptions && !hasCustomInput) {
    return "(cancelled)";
  }

  if (hasSelectedOptions && hasCustomInput) {
    const selectedPart = result.multi
      ? `[${result.selectedOptions.join(", ")}]`
      : result.selectedOptions[0];
    return `${selectedPart} + Other: "${result.customInput}"`;
  }

  if (hasCustomInput) {
    return `"${result.customInput}"`;
  }

  if (result.multi) {
    return `[${result.selectedOptions.join(", ")}]`;
  }

  return result.selectedOptions[0];
}

function formatQuestionResult(result: QuestionResult): string {
  return `${result.id}: ${formatSelectionForSummary(result)}`;
}

function formatQuestionContext(
  result: QuestionResult,
  questionIndex: number,
): string {
  const lines: string[] = [
    `Question ${questionIndex + 1} (${result.id})`,
    `Prompt: ${result.question}`,
  ];

  if (result.markdownCtx) {
    lines.push("Context:");
    for (const descriptionLine of result.markdownCtx.split("\n")) {
      lines.push(`  ${descriptionLine}`);
    }
  }

  lines.push("Options:");
  lines.push(
    ...result.options.map(
      (option, optionIndex) => `  ${optionIndex + 1}. ${option}`,
    ),
  );
  lines.push("Response:");

  const hasSelectedOptions = result.selectedOptions.length > 0;
  const hasCustomInput = Boolean(result.customInput);

  if (!hasSelectedOptions && !hasCustomInput) {
    lines.push("  Selected: (cancelled)");
    return lines.join("\n");
  }

  if (hasSelectedOptions) {
    const selectedText = result.multi
      ? `[${result.selectedOptions.join(", ")}]`
      : result.selectedOptions[0];
    lines.push(`  Selected: ${selectedText}`);
  }

  if (hasCustomInput) {
    if (!hasSelectedOptions) {
      lines.push(`  Selected: ${OTHER_OPTION}`);
    }
    lines.push(`  Custom input: ${result.customInput}`);
  }

  return lines.join("\n");
}

function buildAskSessionContent(results: QuestionResult[]): string {
  const safeResults = results.map(toSessionSafeQuestionResult);
  const summaryLines = safeResults.map(formatQuestionResult).join("\n");
  const contextBlocks = safeResults
    .map((result, index) => formatQuestionContext(result, index))
    .join("\n\n");
  return `User answers:\n${summaryLines}\n\nAnswer context:\n${contextBlocks}`;
}

const ASK_TOOL_DESCRIPTION = "Always used for asking user questions";

export default function askExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_questions",
    label: "Ask",
    description: ASK_TOOL_DESCRIPTION,
    parameters: AskParamsSchema,

    async execute(_toolCallId, params: AskParams, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user_questions tool requires interactive mode",
            },
          ],
          details: {},
        };
      }

      if (params.questions.length === 0) {
        return {
          content: [
            { type: "text", text: "Error: questions must not be empty" },
          ],
          details: {},
        };
      }

      if (params.questions.length === 1) {
        const [q] = params.questions;
        const selection = q.multi
          ? ((await askQuestionsWithTabs(ctx.ui, [q as AskQuestion]))
              .selections[0] ?? { selectedOptions: [] })
          : await askSingleQuestionWithInlineNote(ctx.ui, q as AskQuestion);
        const optionLabels = q.options.map((option) => option.label);

        const result: QuestionResult = {
          id: q.id,
          question: q.question,
          ...(q.markdownCtx && q.markdownCtx.trim().length > 0
            ? { markdownCtx: q.markdownCtx }
            : {}),
          options: optionLabels,
          multi: q.multi ?? false,
          selectedOptions: selection.selectedOptions,
          customInput: selection.customInput,
        };

        const details: AskToolDetails = {
          id: q.id,
          question: q.question,
          ...(q.markdownCtx && q.markdownCtx.trim().length > 0
            ? { markdownCtx: q.markdownCtx }
            : {}),
          options: optionLabels,
          multi: q.multi ?? false,
          selectedOptions: selection.selectedOptions,
          customInput: selection.customInput,
          results: [result],
        };

        return {
          content: [{ type: "text", text: buildAskSessionContent([result]) }],
          details,
        };
      }

      const results: QuestionResult[] = [];
      const tabResult = await askQuestionsWithTabs(
        ctx.ui,
        params.questions as AskQuestion[],
      );
      for (let i = 0; i < params.questions.length; i++) {
        const q = params.questions[i];
        const selection = tabResult.selections[i] ?? { selectedOptions: [] };
        results.push({
          id: q.id,
          question: q.question,
          ...(q.markdownCtx && q.markdownCtx.trim().length > 0
            ? { markdownCtx: q.markdownCtx }
            : {}),
          options: q.options.map((option) => option.label),
          multi: q.multi ?? false,
          selectedOptions: selection.selectedOptions,
          customInput: selection.customInput,
        });
      }

      return {
        content: [{ type: "text", text: buildAskSessionContent(results) }],
        details: { results } satisfies AskToolDetails,
      };
    },
  });
}
