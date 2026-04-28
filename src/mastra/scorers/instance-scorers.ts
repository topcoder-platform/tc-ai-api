import {
  createAnswerRelevancyScorer,
  createPromptAlignmentScorerLLM,
} from '@mastra/evals/scorers/prebuilt';
import { ollama } from '../../utils';

const ollamaBaseUrl = process.env.OLLAMA_API_URL;
const evalModelName = process.env.MASTRA_EVAL_MODEL ?? 'mistral:latest';

console.log(`[instance-scorers] Initializing eval model: ${evalModelName} at ${ollamaBaseUrl}`);

const evalModel = ollama(evalModelName);

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
