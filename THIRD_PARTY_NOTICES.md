# Third-Party Notices

Modus includes source code adapted from the third-party projects listed below.
Their original license terms are reproduced here as required.

## Agent Elements (21st.dev)

- Project: https://github.com/21st-dev/agent-elements
- Component: "Question Tool" (`lib/agent-ui/components/question/question-tool.tsx`,
  `lib/agent-ui/components/question/question-prompt.tsx`), upstream commit
  `b04b36cb6381a1dd1a0e86cc7c90564ddcd56d37`
- Adapted in: `apps/desktop/src/renderer/src/components/question/QuestionCard.tsx`
- Components: "Search Tool" (`lib/agent-ui/components/tools/search-tool.tsx`) and
  "Tool Group" (`lib/agent-ui/components/tools/tool-group.tsx`, with
  `tool-row-base.tsx`), same upstream commit
- Adapted in: `apps/desktop/src/renderer/src/features/agent/SearchToolCard.tsx`,
  `apps/desktop/src/renderer/src/features/agent/ToolGroup.tsx`
- Components: "Todo Tool" (`lib/agent-ui/components/tools/todo-tool.tsx`) and
  "Plan Tool" (`lib/agent-ui/components/tools/plan-tool.tsx`), same upstream commit
- Adapted in: `apps/desktop/src/renderer/src/features/agent/TodosCard.tsx`,
  `apps/desktop/src/renderer/src/features/plan/PlanTool.tsx`
- License: MIT

```
MIT License

Copyright (c) 2026 21st.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## React Bits

- Project: https://github.com/DavidHDev/react-bits (https://reactbits.dev)
- License text below reproduced from `LICENSE.md` at upstream commit
  `ca44b3f9ee180676a06d7de8ec6bea84cddff85b` (file last changed in
  `ecdd797468fc87f7b463157627d1174b0c36fdf5`, 2026-01-01). The upstream commit the
  components were adapted from was not recorded.
- Components: "Aurora" (https://reactbits.dev/backgrounds/aurora) and "Gradient Waves"
  (https://reactbits.dev/backgrounds/gradient-waves)
- Adapted in: `apps/desktop/src/renderer/src/components/ui/Aurora.tsx`,
  `apps/desktop/src/renderer/src/components/ui/GradientWaves.tsx`
- Components: "Fade Content" (https://reactbits.dev/animations/fade-content), "Scroll Reveal"
  (https://reactbits.dev/text-animations/scroll-reveal), "Text Type"
  (https://reactbits.dev/text-animations/text-type) and "Shiny Text"
  (https://reactbits.dev/text-animations/shiny-text)
- Adapted in: `apps/desktop/src/renderer/src/components/ui/FadeContent.tsx`,
  `apps/desktop/src/renderer/src/components/ui/ScrollReveal.tsx`,
  `apps/desktop/src/renderer/src/components/ui/TextType.tsx`,
  `apps/desktop/src/renderer/src/components/ui/ShinyText.tsx`
- Components: "Branched Menu" (https://reactbits.dev/micro/branched-menu), "Spring Check"
  (https://reactbits.dev/micro/spring-check) and "Thought Line"
  (https://reactbits.dev/micro/thought-line)
- Adapted in: `apps/desktop/src/renderer/src/components/ui/BranchedMenu.tsx`,
  `apps/desktop/src/renderer/src/components/ui/SpringCheck.tsx`,
  `apps/desktop/src/renderer/src/components/ui/ThoughtLine.tsx`
- Component: "Prompt Bar" (https://reactbits.dev/components/prompt-bar), send/stop glyph only
- Adapted in: `apps/desktop/src/renderer/src/components/ui/PromptSendGlyph.tsx`
- Styles for the Text Type caret and the Branched Menu: `apps/desktop/src/renderer/src/styles/app.css`
- License: MIT + Commons Clause License Condition v1.0

```
MIT + Commons Clause License Condition v1.0

Copyright (c) 2026 David Haz

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, and distribute the Software **as part of an application, website, or product**, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## Commons Clause Restriction

You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
