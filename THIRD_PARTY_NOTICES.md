# Third-party notices

Excalidraw Desktop includes code adapted from the following projects. npm and Cargo dependencies keep their own licenses in their packages.

## T3 Code

Source: https://github.com/pingdotgg/t3code

Portions of the AI agent integration (engine protocol types, adapter logic, PATH discovery, MCP stdio bridge, test fixtures) are adapted from T3 Code. Files containing adapted code carry a header saying so.

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

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

## elkjs (Eclipse Layout Kernel)

Source: https://github.com/kieler/elkjs

The auto-layout feature ships elkjs unmodified (`elk-api` and `elk-worker.min.js` in the app bundle). elkjs is licensed under the Eclipse Public License 2.0 (https://www.eclipse.org/legal/epl-2.0/), with GPL-3.0 as a Secondary License; this app uses it under EPL-2.0. Its source code is available at the URL above and in the `elkjs` npm package.
