/**
 * Skills Tools Definitions
 * Tool definitions for AI skill discovery and recommendation
 * Matches OpenAI/Claude tool format
 */

import { NormalizedTool } from '../utils/FunctionCalling.js';

export const skillsTools: NormalizedTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_available_skills',
      description: 'Lists all available skills (bundled and user-installed) with their name, description, and whether they are currently active on this agent. Use this when the user asks about capabilities you could have, or when you want to recommend enabling a skill that would help with their request.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'describe_skill',
      description: 'Gets detailed information about a specific skill including its full description, required tools, permissions, source (bundled/user/purchased), and whether it is currently active. Use this to explain what a skill does before recommending the user enable it.',
      parameters: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: 'The ID of the skill to describe (e.g., "wallet-ops", "file-management", "system-admin", "elacity-market"). Use list_available_skills first to get valid IDs.'
          }
        },
        required: ['skill_id']
      }
    }
  }
];
