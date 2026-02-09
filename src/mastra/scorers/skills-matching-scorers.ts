import {
  createAnswerRelevancyScorer,
  createPromptAlignmentScorerLLM,
} from '@mastra/evals/scorers/prebuilt';
import { ollama } from 'ai-sdk-ollama';

const evalModel = ollama(process.env.MASTRA_EVAL_MODEL ?? 'mistral:latest');

export const skillDiscoveryAnswerRelevancyScorer = createAnswerRelevancyScorer({
  model: evalModel,
});

export const skillDiscoveryPromptAlignmentScorer = createPromptAlignmentScorerLLM({
  model: evalModel,
  options: {
    evaluationMode: 'user',
  },
});

export const skillDiscoveryScorers = {
  skillDiscoveryAnswerRelevancyScorer,
  skillDiscoveryPromptAlignmentScorer,
};
