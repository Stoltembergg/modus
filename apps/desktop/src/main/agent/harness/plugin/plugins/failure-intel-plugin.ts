/**
 * Modus Internal Plugin — @modus/failure-intelligence (Fase 10B)
 * Core capability for failure classification, loop prevention, and recovery strategy recommendation.
 */

import type { CapabilityImplementation } from '../../capability/capability-types';
import type { PluginManifest } from '../plugin-types';

export interface FailureClassificationResult {
  category: 'syntax' | 'runtime' | 'environment' | 'timeout' | 'model_hallucination';
  recoverable: boolean;
  strategy: 'retry_with_fix' | 'fallback_model' | 'request_clarification' | 'abort';
  confidence: number;
}

const failureClassifyImpl: CapabilityImplementation<
  { error: string; command?: string },
  FailureClassificationResult
> = {
  execute: (ctx) => {
    const err = ctx.error.toLowerCase();
    if (err.includes('syntaxerror') || err.includes('cannot find module')) {
      return {
        category: 'syntax',
        recoverable: true,
        strategy: 'retry_with_fix',
        confidence: 0.95,
      };
    }
    if (err.includes('timed out') || err.includes('timeout')) {
      return {
        category: 'timeout',
        recoverable: true,
        strategy: 'retry_with_fix',
        confidence: 0.85,
      };
    }
    return {
      category: 'runtime',
      recoverable: true,
      strategy: 'retry_with_fix',
      confidence: 0.7,
    };
  },
};

const failureRecoverImpl: CapabilityImplementation<
  { error: string; attempts: number },
  { shouldContinue: boolean; advice: string }
> = {
  execute: (ctx) => {
    if (ctx.attempts >= 3) {
      return {
        shouldContinue: false,
        advice: 'Maximum failure recovery attempts reached; pausing execution for user input',
      };
    }
    return {
      shouldContinue: true,
      advice: `Attempt ${ctx.attempts + 1}: Suggesting targeted corrective patch`,
    };
  },
};

export const failureIntelPluginManifest: PluginManifest = {
  id: '@modus/failure-intelligence',
  name: 'Modus Failure Intelligence',
  version: '1.0.0',
  author: 'Modus Core Team',
  description: 'Core capability providing automated failure diagnosis and self-healing recommendations',
  trustLevel: 'core',

  provides: [
    {
      capability: 'failure.classify',
      apiVersion: '1.0',
      implementation: failureClassifyImpl,
    },
    {
      capability: 'failure.recover',
      apiVersion: '1.0',
      implementation: failureRecoverImpl,
    },
  ],

  requires: {
    modus: '>=0.8.0',
    capabilities: [
      {
        capability: 'verification.run',
        version: '^1.0',
      },
    ],
  },

  permissions: {
    required: {},
  },
};
