import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkvivoClient } from '../client.js';
import { answer, nextPage, question } from '../project.js';
import { respond, untrustedDescription, viewArg } from '../view.js';
import { idArg, pageArg, readAnnotations } from './common.js';
import { LOOKUP } from './hints.js';

export function registerQuestionTools(server: McpServer, client: WorkvivoClient): void {
  server.registerTool(
    'workvivo_get_question',
    {
      title: 'Read a Workvivo Q&A question and its answers',
      description: untrustedDescription(
        'Read a Workvivo Q&A question (a "question-post" in feeds and search, url `spaces/<space>/questions/<id>`) ' +
          'with its answers: who asked, the question text, whether it is answered, and each answer\'s author, ' +
          'text, votes and whether it is the accepted one. Reading does not count a view. Read-only.',
      ),
      _meta: LOOKUP,
      annotations: readAnnotations('Read a Workvivo Q&A question and its answers'),
      inputSchema: z.object({
        question_id: idArg('question'),
        page: pageArg.describe('Answers page (default 1).'),
        view: viewArg('the question (asker, text, answered state) and each answer\'s author, text, votes and accepted flag'),
      }),
    },
    async ({ question_id, page, view }) => {
      // `question-posts/<id>` and `/answers` are plain GETs; the SPA counts a
      // view with a separate POST (`log-view`) this tool never sends.
      const [q, answers] = await Promise.all([
        client.get(`question-posts/${question_id}`),
        client.get(`question-posts/${question_id}/answers`, { page: page ?? 1 }),
      ]);
      return respond(
        view,
        { question: q, answers },
        (d) => {
          const { question: qq, answers: aa } = d as { question: unknown; answers: { data?: unknown } & Record<string, unknown> };
          if (!Array.isArray(aa?.data)) return undefined;
          const next = nextPage(aa);
          return { question: question(qq), answers: aa.data.map(answer), ...(next !== undefined ? { next_page: next } : {}) };
        },
        'question',
      );
    },
  );
}
