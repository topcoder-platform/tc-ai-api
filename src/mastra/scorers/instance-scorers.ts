import {
  createAnswerRelevancyScorer,
  createPromptAlignmentScorerLLM,
} from '@mastra/evals/scorers/prebuilt';
import { ollama } from 'ai-sdk-ollama';

const evalModel = ollama(process.env.MASTRA_EVAL_MODEL ?? 'mistral:latest');

export const instanceAnswerRelevancyScorer = createAnswerRelevancyScorer({
  model: evalModel,
});

export const instancePromptAlignmentScorer = createPromptAlignmentScorerLLM({
  model: evalModel,
  options: {
    evaluationMode: 'user',
  },
});

export const instanceScorers = {
  instanceAnswerRelevancyScorer,
  instancePromptAlignmentScorer,
};
