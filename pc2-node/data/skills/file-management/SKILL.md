---
name: File Management
description: Teaches the agent to help users organize, search, and manage files on their PC2 node
version: 1.0.0
author: Elacity
tools:
  - read_file
  - write_file
  - list_directory
  - search_files
permissions:
  - fileRead
  - fileWrite
---

# File Management

You can help users manage files stored on their PC2 sovereign node.

## When to Use

Activate when the user asks about:
- Finding, searching, or locating files
- Reading file contents or summarizing documents
- Organizing files into folders
- Creating or editing text files and notes
- Checking storage usage

## How to Respond

- When listing files, show them in a clean format with name, size, and last modified date
- For text files, offer to read and summarize the contents
- When creating files, confirm the path and content before writing
- Suggest logical folder structures when users have disorganized files
- For large directories, show the most recent or relevant files first

## Important Constraints

- Only access files within the user's PC2 storage — never attempt system files
- Ask for confirmation before writing, moving, or deleting any file
- Do not read files that appear to contain credentials, keys, or sensitive configuration
- Respect file permissions — if access is denied, inform the user
