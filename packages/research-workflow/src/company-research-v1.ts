import type { WorkflowDefinition } from './contracts.js'

export const COMPANY_RESEARCH_V1: WorkflowDefinition = {
  id: 'company-research-v1',
  version: '1.0.0',
  finalStage: 'memo',
  requiredReportSections: ['Scope', 'Fundamentals', 'Valuation', 'Risks'],
  stages: [
    {
      id: 'scope',
      dependsOn: [],
      requiredCapabilities: ['instrument-reference'],
      requiredCalculations: [],
      maxAttempts: 2,
    },
    {
      id: 'fundamentals',
      dependsOn: ['scope'],
      requiredCapabilities: ['fundamentals', 'disclosures'],
      requiredCalculations: [],
      maxAttempts: 2,
    },
    {
      id: 'valuation',
      dependsOn: ['fundamentals'],
      requiredCapabilities: ['quote'],
      requiredCalculations: ['valuation'],
      maxAttempts: 2,
    },
    {
      id: 'risks',
      dependsOn: ['valuation'],
      requiredCapabilities: ['disclosures'],
      requiredCalculations: [],
      maxAttempts: 2,
    },
    {
      id: 'memo',
      dependsOn: ['risks'],
      requiredCapabilities: [],
      requiredCalculations: [],
      maxAttempts: 1,
    },
  ],
}
