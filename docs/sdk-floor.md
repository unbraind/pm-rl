# Published pm SDK capability floor

Audited main: `120e20e160897cabe47920713e1b87b6647b2e85`. Required API floor: **2026.8.18**.

Declared host floor: `2026.8.28`. npm peer: `>=2026.8.28`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: applyTerminalOrderingPolicy` | 2026.8.1 | 2026.7.31 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk :: commitWorkspaceTransaction` | 2026.7.19 | 2026.7.18 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk :: mutateItem` | 2026.7.23 | 2026.7.22 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk :: resolveRuntimeStatusRegistry` | 2026.5.14 | 2026.5.12 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk :: runWithActiveExtensions` | 2026.7.21 | 2026.7.20 | [index.ts:211](../index.ts#L211) |
| `@unbrained/pm-cli/sdk/authoring :: defineBeforeMutationHook` | 2026.8.2 | 2026.8.1 | [index.ts:203](../index.ts#L203) |
| `@unbrained/pm-cli/sdk/authoring :: defineCommand` | 2026.7.26 | 2026.7.25 | [index.ts:203](../index.ts#L203) |
| `@unbrained/pm-cli/sdk/authoring :: defineExtension` | 2026.7.26 | 2026.7.25 | [index.ts:203](../index.ts#L203) |
| `@unbrained/pm-cli/sdk/authoring :: defineItemType` | 2026.7.26 | 2026.7.25 | [index.ts:203](../index.ts#L203) |
| `@unbrained/pm-cli/sdk/core :: PmClient` | 2026.7.26 | 2026.7.25 | [process.ts:11](../process.ts#L11), [corpus.ts:2](../corpus.ts#L2), [shadow.ts:3](../shadow.ts#L3), [evaluation-plan.ts:3](../evaluation-plan.ts#L3), [policy-card.ts:4](../policy-card.ts#L4), [prefix-environment.ts:3](../prefix-environment.ts#L3), [tracker-environment.ts:5](../tracker-environment.ts#L5), [meta.ts:4](../meta.ts#L4), [improver-environment.ts:3](../improver-environment.ts#L3), [recursive-improver.ts:3](../recursive-improver.ts#L3), [index.ts:212](../index.ts#L212) |
| `@unbrained/pm-cli/sdk/runtime :: acquireLock` | 2026.5.27 | 2026.5.24 | [index.ts:213](../index.ts#L213), [checkpoint-artifacts.ts:6](../checkpoint-artifacts.ts#L6) |
| `@unbrained/pm-cli/sdk/runtime :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [process.ts:12](../process.ts#L12), [meta.ts:5](../meta.ts#L5), [index.ts:213](../index.ts#L213) |
| `@unbrained/pm-cli/sdk/runtime :: createPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [refuse.ts:14](../refuse.ts#L14), [corpus.ts:3](../corpus.ts#L3), [shadow.ts:4](../shadow.ts#L4), [evaluation-plan.ts:4](../evaluation-plan.ts#L4), [policy-card.ts:5](../policy-card.ts#L5), [index.ts:213](../index.ts#L213) |
| `@unbrained/pm-cli/sdk/runtime :: EXIT_CODE` | 2026.5.27 | 2026.5.24 | [refuse.ts:14](../refuse.ts#L14), [process.ts:12](../process.ts#L12), [lm.ts:36](../lm.ts#L36), [systemone.ts:30](../systemone.ts#L30), [loop.ts:30](../loop.ts#L30), [lineage.ts:23](../lineage.ts#L23), [shadow.ts:4](../shadow.ts#L4), [evaluation-plan.ts:4](../evaluation-plan.ts#L4), [policy-card.ts:5](../policy-card.ts#L5), [meta.ts:5](../meta.ts#L5), [receipt.ts:17](../receipt.ts#L17), [transfer.ts:23](../transfer.ts#L23), [sweep.ts:22](../sweep.ts#L22), [gatesim.ts:26](../gatesim.ts#L26), [index.ts:213](../index.ts#L213) |
| `@unbrained/pm-cli/sdk/runtime :: isPmCliExpectedError` | 2026.6.5 | 2026.5.31 | [refuse.ts:14](../refuse.ts#L14), [process.ts:12](../process.ts#L12), [shadow.ts:4](../shadow.ts#L4), [evaluation-plan.ts:4](../evaluation-plan.ts#L4), [policy-card.ts:5](../policy-card.ts#L5), [meta.ts:5](../meta.ts#L5), [improver-environment.ts:4](../improver-environment.ts#L4), [index.ts:213](../index.ts#L213) |
| `@unbrained/pm-cli/sdk/runtime :: isTerminalStatus` | 2026.7.13 | 2026.7.12 | [index.ts:213](../index.ts#L213) |
| `@unbrained/pm-cli/sdk/runtime :: normalizeItemId` | 2026.5.27 | 2026.5.24 | [process.ts:12](../process.ts#L12), [lineage.ts:23](../lineage.ts#L23), [meta.ts:5](../meta.ts#L5) |
| `BeforeMutationHookContext.before` | 2026.8.2 | 2026.8.1 | [index.ts:529](../index.ts#L529), [index.ts:530](../index.ts#L530) |
| `BeforeMutationHookContext.operation` | 2026.8.2 | 2026.8.1 | [index.ts:539](../index.ts#L539) |
| `BeforeMutationHookContext.sdk` | 2026.8.2 | 2026.8.1 | [index.ts:531](../index.ts#L531) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [index.ts:586](../index.ts#L586), [index.ts:4489](../index.ts#L4489), [index.ts:4514](../index.ts#L4514), [index.ts:4600](../index.ts#L4600), [index.ts:4773](../index.ts#L4773) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [index.ts:615](../index.ts#L615), [index.ts:616](../index.ts#L616), [index.ts:1459](../index.ts#L1459), [index.ts:1804](../index.ts#L1804), [index.ts:4417](../index.ts#L4417), [index.ts:4756](../index.ts#L4756), [index.ts:4804](../index.ts#L4804), [index.ts:5066](../index.ts#L5066), [index.ts:5183](../index.ts#L5183) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [index.ts:578](../index.ts#L578), [index.ts:1327](../index.ts#L1327), [index.ts:1727](../index.ts#L1727), [index.ts:4504](../index.ts#L4504), [index.ts:4526](../index.ts#L4526), [index.ts:4540](../index.ts#L4540) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [index.ts:600](../index.ts#L600), [index.ts:2388](../index.ts#L2388), [index.ts:4431](../index.ts#L4431), [index.ts:4500](../index.ts#L4500), [index.ts:4523](../index.ts#L4523), [index.ts:4539](../index.ts#L4539), [index.ts:4550](../index.ts#L4550), [index.ts:5205](../index.ts#L5205), [index.ts:5206](../index.ts#L5206) |
| `CommandHandlerContext.sdk` | 2026.7.19 | 2026.7.18 | [index.ts:599](../index.ts#L599) |
| `ExtensionApi.hooks` | 2026.5.1 | 2026.3.12 | [index.ts:5367](../index.ts#L5367) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [index.ts:5368](../index.ts#L5368) |
| `ExtensionApi.registerItemTypes` | 2026.5.1 | 2026.3.12 | [index.ts:5366](../index.ts#L5366) |
| `ExtensionCommandSdk.client` | 2026.7.19 | 2026.7.18 | [index.ts:599](../index.ts#L599) |
| `ExtensionMutationGuardSdk.list` | 2026.8.2 | 2026.8.1 | [index.ts:531](../index.ts#L531) |
| `PmClient.claim` | 2026.7.7 | 2026.7.6 | [index.ts:3277](../index.ts#L3277) |
| `PmClient.close` | 2026.7.6 | 2026.7.5 | [index.ts:1228](../index.ts#L1228), [index.ts:3979](../index.ts#L3979) |
| `PmClient.comments` | 2026.7.9 | 2026.7.8 | [index.ts:3201](../index.ts#L3201), [index.ts:3463](../index.ts#L3463), [index.ts:3472](../index.ts#L3472) |
| `PmClient.config` | 2026.7.9 | 2026.7.8 | [process.ts:206](../process.ts#L206), [process.ts:267](../process.ts#L267), [evaluation-plan.ts:134](../evaluation-plan.ts#L134), [evaluation-plan.ts:246](../evaluation-plan.ts#L246), [policy-card.ts:74](../policy-card.ts#L74), [policy-card.ts:229](../policy-card.ts#L229), [policy-card.ts:284](../policy-card.ts#L284), [policy-card.ts:321](../policy-card.ts#L321), [policy-card.ts:351](../policy-card.ts#L351), [policy-card.ts:373](../policy-card.ts#L373), [policy-card.ts:426](../policy-card.ts#L426), [meta.ts:132](../meta.ts#L132), [index.ts:764](../index.ts#L764), [index.ts:1946](../index.ts#L1946), [index.ts:2093](../index.ts#L2093), [index.ts:2209](../index.ts#L2209), [index.ts:2363](../index.ts#L2363), [index.ts:2415](../index.ts#L2415), [index.ts:2472](../index.ts#L2472), [index.ts:5264](../index.ts#L5264) |
| `PmClient.create` | 2026.7.6 | 2026.7.5 | [process.ts:295](../process.ts#L295), [shadow.ts:108](../shadow.ts#L108), [evaluation-plan.ts:146](../evaluation-plan.ts#L146), [evaluation-plan.ts:221](../evaluation-plan.ts#L221), [meta.ts:219](../meta.ts#L219), [meta.ts:295](../meta.ts#L295), [index.ts:910](../index.ts#L910), [index.ts:1303](../index.ts#L1303), [index.ts:1358](../index.ts#L1358), [index.ts:1626](../index.ts#L1626), [index.ts:1742](../index.ts#L1742), [index.ts:3067](../index.ts#L3067), [index.ts:3419](../index.ts#L3419), [index.ts:3426](../index.ts#L3426), [index.ts:4950](../index.ts#L4950), [index.ts:4990](../index.ts#L4990), [index.ts:5110](../index.ts#L5110) |
| `PmClient.delete` | 2026.7.7 | 2026.7.6 | [index.ts:4870](../index.ts#L4870) |
| `PmClient.forActiveExtensionHost` | 2026.7.19 | 2026.7.18 | [index.ts:600](../index.ts#L600) |
| `PmClient.get` | 2026.7.6 | 2026.7.5 | [index.ts:755](../index.ts#L755), [index.ts:820](../index.ts#L820), [index.ts:3065](../index.ts#L3065), [index.ts:4731](../index.ts#L4731) |
| `PmClient.init` | 2026.7.9 | 2026.7.8 | [index.ts:3059](../index.ts#L3059) |
| `PmClient.list` | 2026.7.6 | 2026.7.5 | [index.ts:1239](../index.ts#L1239), [index.ts:1775](../index.ts#L1775), [index.ts:1788](../index.ts#L1788), [index.ts:2060](../index.ts#L2060), [index.ts:2094](../index.ts#L2094), [index.ts:4737](../index.ts#L4737), [index.ts:5160](../index.ts#L5160) |
| `PmClient.listAllComplete` | 2026.8.18 | 2026.8.17 | [process.ts:265](../process.ts#L265), [corpus.ts:92](../corpus.ts#L92), [corpus.ts:177](../corpus.ts#L177), [shadow.ts:118](../shadow.ts#L118), [policy-card.ts:282](../policy-card.ts#L282), [meta.ts:130](../meta.ts#L130), [meta.ts:204](../meta.ts#L204), [index.ts:1390](../index.ts#L1390) |
| `PmClient.notes` | 2026.7.9 | 2026.7.8 | [index.ts:873](../index.ts#L873) |
| `PmClient.release` | 2026.7.7 | 2026.7.6 | [index.ts:3294](../index.ts#L3294) |
| `PmClient.run` | 2026.7.6 | 2026.7.5 | [policy-card.ts:81](../policy-card.ts#L81), [index.ts:3839](../index.ts#L3839), [index.ts:4842](../index.ts#L4842) |
| `PmClient.schemaAddType` | 2026.7.9 | 2026.7.8 | [index.ts:835](../index.ts#L835) |
| `PmClient.update` | 2026.7.6 | 2026.7.5 | [process.ts:297](../process.ts#L297), [process.ts:323](../process.ts#L323), [process.ts:324](../process.ts#L324), [prefix-environment.ts:68](../prefix-environment.ts#L68), [meta.ts:297](../meta.ts#L297), [meta.ts:361](../meta.ts#L361), [index.ts:1173](../index.ts#L1173), [index.ts:3004](../index.ts#L3004), [index.ts:4204](../index.ts#L4204) |
| `PmCliErrorContext.code` | 2026.5.14 | 2026.5.12 | [refuse.ts:18](../refuse.ts#L18), [refuse.ts:34](../refuse.ts#L34), [process.ts:522](../process.ts#L522), [shadow.ts:88](../shadow.ts#L88), [policy-card.ts:90](../policy-card.ts#L90), [improver-environment.ts:115](../improver-environment.ts#L115), [improver-environment.ts:118](../improver-environment.ts#L118), [index.ts:791](../index.ts#L791), [index.ts:2390](../index.ts#L2390), [index.ts:3141](../index.ts#L3141), [index.ts:3142](../index.ts#L3142), [index.ts:3155](../index.ts#L3155), [index.ts:3158](../index.ts#L3158), [index.ts:3161](../index.ts#L3161), [index.ts:3162](../index.ts#L3162), [index.ts:3166](../index.ts#L3166), [index.ts:3753](../index.ts#L3753), [index.ts:3833](../index.ts#L3833) |
| `WorkspaceTransactionTransitionContext.transition` | 2026.7.19 | 2026.7.18 | [index.ts:2874](../index.ts#L2874) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.5.24 | `9d28fff4b06405ea5691ee919ad646c86c0a416a5007ca8104b19251306262af` |
| 2026.5.27 | `afd3c6e0ecca429510f049019069802c0034a3e99fb711035b5b22fc8fa643dd` |
| 2026.5.31 | `d3b4a795704588e414070a22a4034d7fbd7a290a050509cc4852e0051c0969a7` |
| 2026.6.5 | `bb47c85bb2ce1a8ba858651af8d1f4ca6888bc731d0aaaa63a4b97427219cd89` |
| 2026.7.5 | `4a6664f68120cace5648faf48d51b08c14e969d9c7e185e592f1a0fceae57274` |
| 2026.7.6 | `0d6e446cf93a0f0660ce4e21943adf1e0c21381010ef67369f40cc9834b8d158` |
| 2026.7.7 | `c455dbda90d6f5aff55b23517683376ea6ab74d4a1540f3f8274590b1687c47e` |
| 2026.7.8 | `b892cce02e555decd3f0d09af0d2a5d8817494fe577e357ffaea84ef385a9b6a` |
| 2026.7.9 | `87600f77a82d5e66c8ac05f120b435a0fb22b5fad42ae5db4540bb4ca45a01ea` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.18 | `44b48fe680cf330254a4ab8d42b55cbcee81ba5cf21e4d4550b40413265d64b9` |
| 2026.7.19 | `513e0aead42767a113a26b8b2e2cbb8a22879d0cb0500d4d3cdd16d21d9f7a39` |
| 2026.7.20 | `6fbc1d789477491e007d03396dbf1dd2f09376220059887faf6f9d50668a6b08` |
| 2026.7.21 | `99151effed0e40579f01629f135a73384cb8e8f922c6c63da497638507009452` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.25 | `20dfec2ca4ddfcebd484af686b76aebcb1f479a7b81c781380a7fe6b6f8506f5` |
| 2026.7.26 | `b10b647a7fce423106dfb964934ac2d43b8770f8f085df89a13c9a04e75569cc` |
| 2026.7.31 | `8ce72b29927e96afbbdae1f763ecddf8956a1815e1460fbd8809eb769c5938c2` |
| 2026.8.1 | `242013e81ed2c4329a3cb20d3e70fa58f6dbb627d00c2c1e883562e786850f80` |
| 2026.8.2 | `c9f8e516319ba4d6609ea0272e4fa70360668531c379ec54b29df8aa418293e3` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
