import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  /*
   * ★ `.trash/` 必须 ignore，理由有二，且都不是"图省事"：
   *   ① 它是**回收站**（`renameSync` 进这里），内容是历史上各轮淘汰掉的临时脚本，
   *      **没有维护义务**却会持续产出 lint 红（当前 17 条）。
   *   ② 更危险的是会让 `npm run lint` 这个门**随垃圾堆积而变红** ——
   *      于是"红"不再指向"我这轮写错了什么"，人就会开始忽略它（判据 2）。
   *   ★ 注意 `lint` 脚本本身已经是 `eslint src scripts server`（本来就扫不到 .trash），
   *     这里补 ignore 是为了让**有人手敲 `eslint .`** 时也得到同样结论，两条路一致。
   */
  { ignores: ['dist', 'node_modules', '.trash', '*.timestamp-*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  /*
   * ══ 独立的 .mjs 工具脚本：给它们 Node 的全局量 ═══════════════════════════
   *
   * ★ 上面那条 `**\/*.{ts,tsx}` 只覆盖 TS/TSX，`scripts/**\/*.mjs` 落在**没有任何
   *   languageOptions** 的裸 `js.configs.recommended` 上 —— 于是 `process` /
   *   `console` / `fetch` / `setTimeout` 全被判 `no-undef`。
   *
   * ★★ 为什么这值得单独写一段注释而不是随手加一行 globals：
   *    这**不是**"代码有问题"，而是"配置漏了范围"。若不写清，下一次有人看到
   *    `npm run ci` 报 `'process' is not defined`，第一反应会是去改脚本
   *    （比如换成 `globalThis.process`）—— **为了让检查器闭嘴而改正确的代码**，
   *    这是本仓最不能接受的一类动作。
   *    ⇒ 所以正确处置是补 languageOptions，并且**不改任何脚本源码**。
   *
   * ★ 只补 node，不补 browser：这些文件跑在 Node 里，给它们 `document` / `window`
   *    反而会放过真正的误用（脚本里出现 `document` 一定是写错了）。
   */
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  /*
   * ══ `quote-check.cjs` 是 **CommonJS**，`require()` 在这里是正确写法 ═════════
   *
   * ★ 为什么不能靠"把它排除掉"或"改成 import"了事：
   *   · 排除 ⇒ `quote-check.cjs` 是 **CI 真跑的一步**（`.github/workflows/ci.yml:30`，
   *     mainnet 询价冒烟，`continue-on-error`）。把 CI 跑的文件排除在 lint 之外，
   *     等于**对唯一跑在真链上的脚本不设防**（判据 10：有入口 ≠ 有人读）。
   *   · 改 `import` ⇒ 它是 `.cjs`，Node 按 CommonJS 解析，改成 ESM 语法直接崩；
   *     `viem` 的用法也要跟着改。**为了让检查器闭嘴而动一个能跑的 CI 步骤**，
   *     是本仓明确禁止的动作（同 §3.40.2 的教训）。
   * ⇒ 正解是**把这条规则的作用域说准**：它防的是"在 ESM 里混用 require"，
   *   而不是"CJS 文件不许 require"。
   *
   * ★ `no-require-imports` 只关这一个文件，且**关掉的是"语法选择"不是"检查"** ——
   *   该文件的运行结果由 CI 那一步自己负责（`continue-on-error: true`，
   *   失败会被记录但不拦线，见 `README.md:62`）。
   */
  {
    files: ['quote-check.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  /*
   * ══ 只对 TerminalPage 关掉「能不能保住手写 memo」这一条 ══════════════════
   *
   * `react-hooks/preserve-manual-memoization` 是**编译期规则**：它由 React Compiler
   * 产生，回答"编译器能不能保住你手写的 useMemo/useCallback"。
   *
   * ★★ 而本项目**没有**把 React Compiler 接进构建管线 —— `vite.config.ts` 里只有
   *    `@vitejs/plugin-react`，依赖里没有 `babel-plugin-react-compiler`。
   *    编译器不跑 ⇒ 这条规则的红**不可能对应任何发布出去的行为**：
   *    useMemo / useCallback 在运行时照旧生效。上面那两条 `purity` /
   *    `set-state-in-effect` 关掉是同一个理由，这里只是把它写明白。
   *
   * ★ 它为什么在这一轮才红：`TerminalPage.tsx` 越过了编译器的分析预算。
   *   实测（2026-09-21，逐块删减观察条数，每次都先断言探针本身能解析）：
   *     · 只留逻辑、JSX 换成 return null     ⇒ 编译跳过 **0** 条
   *     · 完整文件                            ⇒ **10** 条
   *     · 单独删掉交易对列表（68 行）          ⇒ 仍是 **10**
   *     · 单独删掉中列 K线+走势（215 行）      ⇒ 仍是 **10**
   *     · 删掉下单面板里那块条件（240 行）     ⇒ **0**
   *     · 往小版本里塞 400 个普通 JSX 元素     ⇒ 仍是 **0**（**体积本身不是原因**）
   *   即：**我没有定位到某一个具体写法**，只确认它是"整块分析的复杂度跨过了阈值"，
   *   而且只有大幅削减（≥240 行）才回得来，加一点减一点都无效。
   *   ⇒ 这是 `TerminalPage.tsx` **过大**（1400+ 行）的症状，不是某处写错。
   *
   * ★ 关掉是**有前提的**，前提写成了可执行的断言而不是这句话本身：
   *   `scripts/ui-actions-smoke.ts` 的 U31a/U31b 会在「构建管线里出现 React Compiler」
   *   或「这条 off 扩散到了别的文件」时变红 —— 那时必须回来重新评估。
   * ★ 欠账：把 `TerminalPage.tsx` 拆成 PairList / ChartCard / ForecastCard /
   *   OrderPanel / OrdersCard 五个组件，拆完就把这条 off 删掉。
   */
  {
    files: ['src/pages/TerminalPage.tsx'],
    rules: { 'react-hooks/preserve-manual-memoization': 'off' },
  },
)
