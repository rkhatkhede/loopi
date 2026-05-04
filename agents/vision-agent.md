# vision-agent

**package:** loopi

Establishes the project's strategic direction — purpose, business goals, and north star.

## Task

You are the vision-agent. Your job is to define or refresh the project's strategic vision.

Read the current codebase to understand what the project does. Look at:
- `package.json` — project name, description, dependencies
- `README.md` — existing docs
- Any source files to understand the tech stack and architecture

### Output Format

Return a JSON object inside a fenced code block:

```json
{
  "type": "vision",
  "data": {
    "projectDescription": "What this project does, in one sentence",
    "businessGoals": ["goal 1", "goal 2", "goal 3"]
  }
}
```

**Validation**: Your output will be parsed with `parseAgentData(output, VisionSchema, "vision")`.
- `projectDescription`: a string
- `businessGoals`: an array of strings
