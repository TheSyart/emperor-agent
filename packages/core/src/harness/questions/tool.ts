/**
 * `ask_user_question` (ported from dsh-tool-ask-user): pauses until the
 * host answerer returns the human's answers, then feeds them back as an
 * ordinary tool result.
 */

import { z } from 'zod'
import { defineTool, ToolError, type ToolDefinition } from '../tools/definition'
import type {
  UserAnswers,
  UserQuestionItem,
  UserQuestionService,
} from './service'

const DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. ' +
  'Send one or more questions, each with a stable id that will be echoed in the answer.'

const askInput = z.object({
  questions: z
    .array(
      z.looseObject({
        id: z
          .string()
          .describe('Stable id for this question; echoed in the answer.'),
        question: z.string().describe('The specific question to ask the user.'),
        header: z
          .string()
          .describe(
            'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
          )
          .optional(),
        options: z
          .array(
            z.looseObject({
              label: z.string().describe('Short user-facing option label.'),
              description: z
                .string()
                .describe('One sentence explaining the tradeoff or impact.')
                .optional(),
            }),
          )
          .describe(
            'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
          )
          .optional(),
        multi_select: z
          .boolean()
          .describe(
            'Whether the user may select more than one option. Defaults to false.',
          )
          .optional(),
      }),
    )
    .describe('Questions to ask the user before continuing.'),
})

type AskArgs = z.output<typeof askInput>

/** dsh result encoding: `{ answers: [{ id, selected, custom? }] }` in question order. */
export function renderAnswers(
  questions: readonly { id: string }[],
  answers: UserAnswers,
): string {
  const list = questions.flatMap((question) => {
    const answer = answers[question.id]
    if (answer === undefined) return []
    return [
      {
        id: question.id,
        selected: [...answer.selected],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      },
    ]
  })
  return JSON.stringify({ answers: list })
}

export function createAskUserQuestionTool(
  service: UserQuestionService,
): ToolDefinition<AskArgs> {
  return defineTool({
    name: 'ask_user_question',
    description: DESCRIPTION,
    input: askInput,
    async execute(args, context) {
      if (context.agent === undefined)
        throw new ToolError(
          'ask_user_question requires a calling agent',
          'NO_AGENT',
        )
      const questions: UserQuestionItem[] = args.questions.map((question) => ({
        id: question.id,
        question: question.question,
        ...(question.header === undefined ? {} : { header: question.header }),
        ...(question.options === undefined
          ? {}
          : {
              options: question.options.map((o) => ({
                label: o.label,
                ...(o.description === undefined
                  ? {}
                  : { description: o.description }),
              })),
            }),
        ...(question.multi_select === undefined
          ? {}
          : { multiSelect: question.multi_select }),
      }))
      const result = await service.ask({
        agent: context.agent,
        callId: context.callId,
        questions,
        signal: context.signal,
      })
      switch (result.outcome) {
        case 'cancelled':
          throw new ToolError(
            'ask_user_question was aborted before the user answered',
            'ASK_ABORTED',
          )
        case 'unavailable':
          throw new ToolError(
            'no user-questions answerer is available',
            'NO_PROVIDER',
          )
        case 'answered':
          return {
            content: renderAnswers(questions, result.answers),
            meta: { answers: structuredClone(result.answers) },
          }
      }
    },
  })
}
