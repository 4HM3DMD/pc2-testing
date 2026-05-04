/**
 * Agent Tools Definitions
 * Multi-agent communication tools that let one AI agent discover
 * and delegate tasks to other configured agents.
 */

import { NormalizedTool } from '../utils/FunctionCalling.js';

export const agentTools: NormalizedTool[] = [
  {
    type: 'function',
    function: {
      name: 'agents_list',
      description: 'Lists all configured AI agents on this PC2 node with their name, model, enabled status, and active skills. Use this to discover which agents exist and what they specialize in before delegating a task.',
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
      name: 'agent_delegate',
      description: 'Sends a question or task to another AI agent and returns their response. Use this when a user asks something outside your expertise and another agent has the right skills or knowledge. The other agent processes the message independently using its own soul, skills, and model. You receive the text response and can incorporate it into your reply. Maximum delegation depth is 1 (the target agent cannot delegate further).',
      parameters: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'string',
            description: 'The ID of the agent to delegate to. Use agents_list first to discover available agent IDs.'
          },
          message: {
            type: 'string',
            description: 'The question or task to send to the other agent. Be specific and include context — the other agent does not see the current conversation history.'
          }
        },
        required: ['agent_id', 'message']
      }
    }
  }
];
