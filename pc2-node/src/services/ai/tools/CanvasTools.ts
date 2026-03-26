/**
 * Canvas Tools Definitions
 * A2UI-inspired canvas tools that let the AI agent push live HTML widgets
 * as desktop windows via Socket.IO -> UIWindow(iframe_srcdoc).
 */

import { NormalizedTool } from '../utils/FunctionCalling.js';

export const canvasTools: NormalizedTool[] = [
  {
    type: 'function',
    function: {
      name: 'canvas_create',
      description: 'Opens a new desktop window with the given HTML content. Use this to show dashboards, tables, comparison views, forms, or any visual content that is better displayed as a window than as chat text. The window is draggable, resizable, and stays open until the user closes it. Returns a canvas_id you can use to update or remove the window later.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Window title shown in the title bar and taskbar. Keep it short and descriptive (e.g., "Wallet Dashboard", "NFT Comparison").'
          },
          html: {
            type: 'string',
            description: 'HTML content to render inside the window. Use inline styles only (no external stylesheets or scripts). Prefer clean, semantic HTML with inline CSS. Use dark backgrounds (#1e1e2e or similar) with light text (#e0e0e0) for consistency with the desktop theme. Tables, lists, and grid layouts work well.'
          },
          width: {
            type: 'number',
            description: 'Window width in pixels. Defaults to 600. Recommended range: 400-900.'
          },
          height: {
            type: 'number',
            description: 'Window height in pixels. Defaults to 400. Recommended range: 300-700.'
          }
        },
        required: ['title', 'html']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'canvas_update',
      description: 'Updates the HTML content of an existing canvas window. Use this to refresh data in a dashboard or change what is displayed without opening a new window. The window must have been created with canvas_create first.',
      parameters: {
        type: 'object',
        properties: {
          canvas_id: {
            type: 'string',
            description: 'The canvas_id returned by canvas_create.'
          },
          html: {
            type: 'string',
            description: 'New HTML content to replace the current content.'
          },
          title: {
            type: 'string',
            description: 'Optional new title for the window.'
          }
        },
        required: ['canvas_id', 'html']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'canvas_remove',
      description: 'Closes and removes a canvas window. Use this when the information is no longer relevant or the user is done with it.',
      parameters: {
        type: 'object',
        properties: {
          canvas_id: {
            type: 'string',
            description: 'The canvas_id of the window to close.'
          }
        },
        required: ['canvas_id']
      }
    }
  }
];
