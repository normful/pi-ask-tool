import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { OTHER_OPTION, type AskQuestion } from "./ask-logic";
import { askSingleQuestionWithInlineNote } from "./ask-inline-ui";
import { askQuestionsWithTabs } from "./ask-tabs-ui";

const OptionItemSchema = Type.Object({
  label: Type.String({
    description: "Only thing user sees when choosing. Supports Markdown",
  }),
});

const QuestionItemSchema = Type.Object({
  id: Type.String({ description: "unique key" }),
  question: Type.String({
    description: "Question for user. Supports Markdown",
  }),
  markdownCtx: Type.String({
    description: "Context alongside question. Supports Markdown",
  }),
  options: Type.Array(OptionItemSchema, {
    description: "Choices for user (DO NOT include Other)",
    minItems: 1,
  }),
  multi: Type.Boolean({
    description: "User should choose multiple answers",
  }),
  recommended: Type.Number({
    description: "Your recommended option (0-indexed)",
  }),
});

const AskParamsSchema = Type.Object({
  questions: Type.Array(QuestionItemSchema, {
    minItems: 1,
  }),
});

type AskParams = Static<typeof AskParamsSchema>;

interface QuestionResult {
  id: string;
  question: string;
  markdownCtx: string;
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

function validateQuestions(questions: AskParams["questions"]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const prefix = `questions[${i}]`;

    // id: required non-empty string
    if (typeof q.id !== "string" || q.id.trim().length === 0) {
      errors.push(`${prefix}.id: must be a non-empty string`);
    }

    // question: required non-empty string
    if (typeof q.question !== "string" || q.question.trim().length === 0) {
      errors.push(`${prefix}.question: must be a non-empty string`);
    }

    // markdownCtx: required string (now non-optional)
    if (typeof q.markdownCtx !== "string") {
      errors.push(`${prefix}.markdownCtx: must be a string`);
    }

    // options: required non-empty array
    if (!Array.isArray(q.options) || q.options.length === 0) {
      errors.push(`${prefix}.options: must be a non-empty array`);
    } else {
      // validate each option label
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        if (
          !opt ||
          typeof opt.label !== "string" ||
          opt.label.trim().length === 0
        ) {
          errors.push(
            `${prefix}.options[${j}].label: must be a non-empty string`,
          );
        }
      }

      // recommended: required finite number within option bounds
      if (typeof q.recommended !== "number" || !Number.isFinite(q.recommended)) {
        errors.push(`${prefix}.recommended: must be a finite number`);
      } else if (
        q.recommended < 0 ||
        q.recommended >= q.options.length
      ) {
        errors.push(
          `${prefix}.recommended: must be between 0 and ${q.options.length - 1}`,
        );
      }
    }

    // multi: required boolean
    if (typeof q.multi !== "boolean") {
      errors.push(`${prefix}.multi: must be a boolean`);
    }
  }
  return errors;
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

  const rawCustomInput = result.customInput;
  const customInput =
    rawCustomInput == null ? undefined : sanitizeForSessionText(rawCustomInput);

  return {
    id: sanitizeForSessionText(result.id) || "(unknown)",
    question: sanitizeForSessionText(result.question) || "(empty question)",
    markdownCtx: sanitizeMultilineForSessionText(result.markdownCtx),
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

function buildAskSessionContent(results: QuestionResult[]): string {
  const safeResults = results.map(toSessionSafeQuestionResult);
  const summaryLines = safeResults.map(formatQuestionResult).join("\n");
  return `User answers:\n${summaryLines}`;
}

const ASK_TOOL_DESCRIPTION = "ALWAYS use this tool to ask user questions";

export default function askExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "socrates",
    label: "Socrates",
    description: ASK_TOOL_DESCRIPTION,
    parameters: AskParamsSchema,

    async execute(_toolCallId, params: AskParams, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: tool requires interactive mode",
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

      const validationErrors = validateQuestions(params.questions);
      if (validationErrors.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Validation errors:\n${validationErrors.map((e) => `  - ${e}`).join("\n")}`,
            },
          ],
          details: {},
        };
      }

      const questionsAsAskQuestions: AskQuestion[] = params.questions;

      if (params.questions.length === 1) {
        const [q] = params.questions;
        const uiQ = questionsAsAskQuestions[0];
        const selection = q.multi
          ? ((await askQuestionsWithTabs(ctx.ui, [uiQ])).selections[0] ?? {
              selectedOptions: [],
            })
          : await askSingleQuestionWithInlineNote(ctx.ui, uiQ);
        const optionLabels = q.options.map((option) => option.label);

        const result: QuestionResult = {
          id: q.id,
          question: q.question,
          markdownCtx: q.markdownCtx,
          options: optionLabels,
          multi: q.multi ?? false,
          selectedOptions: selection.selectedOptions,
          customInput: selection.customInput,
        };

        const details: AskToolDetails = {
          id: q.id,
          question: q.question,
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
        questionsAsAskQuestions,
      );
      for (let i = 0; i < params.questions.length; i++) {
        const q = params.questions[i];
        const selection = tabResult.selections[i] ?? { selectedOptions: [] };
        results.push({
          id: q.id,
          question: q.question,
          markdownCtx: q.markdownCtx,
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
