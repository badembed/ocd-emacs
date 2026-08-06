# AGENT.md — ocd: CLI-обёртка над OpenCode

Последнее обновление: 2026-08-06.

## Что это

**ocd** — консольная утилита (одна строка в терминале), которая принимает один вопрос и потоково выводит ответ OpenCode в stdout. Альтернатива `opencode` для быстрых одноразовых запросов.

```bash
ocd "что такое 2+2?"                    # простой вопрос
ocd file.ts "отрефактори"               # файл как контекст
ocd folder/ "что здесь?"                # листинг папки как контекст
ocd -p "объясни"                        # текст из буфера обмена
ocd -s auth "продолжи"                  # именованная сессия (создать/возобновить)
ocd --list-sessions                     # список именованных сессий
ocd -s auth -p file.ts "всё вместе"     # комбинации
```

**Что НЕ делает** (осознанно): TUI, интерактивный режим, multi-turn в одном вызове, Windows, флаги `--model`/`--agent`/`--command`. Один вопрос → один ответ. Сессии нужны для контекста между вызовами, не для диалога.

## Ключевые решения

| Решение | Почему |
|---|---|
| TypeScript + `@opencode-ai/sdk` (v1.18.14) | Полный контроль над сессиями и стримингом без shell-костылей |
| `bun build --compile` | Нативный бинарник, не требует Node.js у пользователя |
| Именованные сессии (`-s name`) | Не нужно помнить/копировать `ses_...` ID; маппинг в `~/.ocd/sessions.json` |
| Реальный стриминг через SSE | Символы появляются по мере генерации (не batch) |
| `OCD_SERVER_URL` в discovery | Совместимость с форком OpenCode пользователя |
| `clipboardy` | Кроссплатформенный доступ к буферу обмена |
| Agent-executed QA, без юнит-тестов | Каждый сценарий проверяется запуском реального бинарника |

## Поиск OpenCode (порядок приоритета)

1. `OCD_SERVER_URL` → `createOpencodeClient({ baseUrl })` + probe `session.list()` (ленивый клиент — ошибка всплывает только на первом запросе, поэтому probe обязателен)
2. `OPENCODE_BIN_PATH` → проверка существования файла, префикс dirname в `PATH`, авто-спавн (у `ServerOptions` НЕТ `binPath` — обрабатываем через PATH)
3. дефолт → `createOpencode()` авто-спавн `opencode serve` (cross-spawn ищет в PATH)

## Структура `src/ocd.ts` (465 строк, один файл)

| Блок | Функции | Задача |
|---|---|---|
| Session store | `readMapping`, `writeMapping`, `resolveSession`, `listSessions` | T5 |
| Client resolver | `resolveClient`, `closeSpawnedServer` (module-level `spawnedServer`) | T4 |
| CLI parsing | `program` (commander): `[path] [question]`, `-p`, `-s`, `--list-sessions` | T3 |
| Context assembly | `assembleParts` → `TextPartInput[]` (clipboard → file/folder → question) | T6 |
| Streaming | `streamResponse`: `promptAsync` + `event.subscribe()` SSE, batch-fallback на `prompt()` | T7 |

## Критичные SDK-факты (проверено по установленному пакету)

- `createOpencode(options?: ServerOptions)` → `{ client, server: { url, close() } }` — спавнит `opencode serve --hostname=X --port=Y`, ждёт строку `opencode server listening on <url>`.
- `createOpencodeClient({ baseUrl, directory })` — **ленивый** fetch-клиент: ошибка соединения только на первом вызове API.
- `client.session.promptAsync({ path: { id }, body: { parts } })` — fire-and-forget; текст приходит через SSE.
- `client.event.subscribe()` → `{ stream: AsyncGenerator }`. События:
  - `message.part.updated` → `{ part: TextPart|ToolPart, delta?: string }` — дельты текста ассистента;
  - `session.status` → `{ status: { type: "idle" } }` — завершение обработки.
- Типы: `TextPartInput = { type: "text", text }`; `FilePartInput` требует URL — **не используется**, контекст всегда TextPartInput.
- Эхо-фильтр: первый message (вопрос пользователя) НЕ выводится; стримим только текст ассистента по `delta`.

## Что сделано (7/11 задач + 1 фикс)

| Задача | Коммит | Содержимое | Верификация |
|---|---|---|---|
| T1 package.json | `f5d342b` | deps (`@opencode-ai/sdk`, `commander`, `clipboardy`, `@types/node`, `typescript`), скрипты `build`/`build:all`, `.gitignore` (node_modules/, dist/) | `bun install` ✓, `bun run build` → Mach-O бинарник ✓ |
| T2 tsconfig.json | `2f0056b` | strict, ESNext, moduleResolution bundler, noUnusedLocals/Parameters | `tsc --noEmit` ✓, негатив: намеренная ошибка типов ловится ✓ |
| T3 CLI skeleton | `7369b1c` | commander-парсинг, дизамбигуация path/question (один позиционный = вопрос) | 8 acceptance-сценариев ✓ |
| T4 client resolver | `a88b9c7` | `resolveClient` 3-уровневый discovery, probe `session.list()`, `closeSpawnedServer` | A1-A5 ✓ (включая ошибки exit 1) |
| T5 session manager | `10a7786` | `~/.ocd/sessions.json`, `resolveSession` (stale-восстановление, `ses_` passthrough), `listSessions` (console.table) | S1-S8 ✓ (stale mapping, corrupt JSON) |
| T6 context assembly | `82e2f23` | `assembleParts`: clipboard → file/folder → question, бинарные файлы, ошибки | C1-C8 ✓ |
| **фикс** | `871f328` | **Утечка сервера на error-путях**: `process.exit(1)` в catch блокировал `finally { closeSpawnedServer() }` → orphan `opencode serve` на порту 4096. Фикс: паттерн `exitCode` + exit после finally | C5/C6: exit 1 БЕЗ orphans ✓ |
| T7 streaming | `c79c895` | `streamResponse`: promptAsync + SSE, эхо-фильтр, `[tool: ...]` в stderr, batch-fallback | S1-S8 ✓ (контекст сессии, MESSAGES=8 в листинге) |

### Найденные и исправленные баги

1. **Утечка `opencode serve`** (найдено при верификации T6): `process.exit(1)` внутри `catch` не давал выполниться `finally { closeSpawnedServer() }`. Исправлено в `871f328` заменой на `exitCode`-переменную. **Правило на будущее: никогда не вызывать `process.exit` внутри try/catch до finally.**

## Что осталось

### Wave 3 (сборка + QA)
- [ ] **T8 Main integration** — собрать всё в `main()`: порядок (аргументы → list-sessions → валидация question → client → session → parts → stream), убрать debug-выводы. Требует: `question required` при пустом вопросе.
- [ ] **T9 Build** — `bun build --compile` для 4 таргетов: `bun-darwin-arm64-modern`, `bun-darwin-x64-modern`, `bun-linux-x64-modern`, `bun-linux-arm64-modern`; скрипты `build:mac-arm`/`build:mac-x64`/`build:linux-x64`/`build:linux-arm64`/`build:all`; `dist/` уже в .gitignore.
- [ ] **T10 QA macOS arm64** — smoke (a)-(g) на собранном бинарнике: базовый вопрос, файл, clipboard, сессия с запоминанием (42), повторный вопрос (контекст), list-sessions, ошибка.
- [ ] **T11 QA Linux x64** — те же сценарии на Linux (Docker с bun), проверка `xclip`/`wl-paste`, права 600 на `~/.ocd/sessions.json`.

### Final verification wave
- [ ] **F1** Plan compliance: Scope IN покрыт, Scope OUT отсутствует.
- [ ] **F2** Code quality: <300 строк (сейчас 465 — **нужно декомпозировать** или обосновать), нет `any`, ошибки обработаны.
- [ ] **F3** Cross-platform: 4 бинарника в `dist/`, все проходят `--help`.
- [ ] **F4** Edge cases: 7 сценариев (несуществующий файл, пустой вопрос, бинарный файл, пустой clipboard, OpenCode не найден, `~/.ocd` отсутствует, повреждённый sessions.json).

> ⚠️ **F2 конфликт с планом**: план требовал один файл <300 строк, сейчас 465. При T8 либо вынести session-store/context/streaming в отдельные модули, либо согласовать с пользователем отклонение от лимита. План это не запрещает явно (в Scope IN один файл не зафиксирован), но F2 сформулирован как «один файл, <300 строк».

## Как запускать и проверять

```bash
cd /Users/alexantonov/sources/ocd
bun install                       # зависимости
bun run src/ocd.ts "вопрос"      # dev-режим (TypeScript напрямую)
bun run build                     # собрать бинарник для текущей платформы
./dist/ocd "вопрос"               # собранный бинарник
bunx tsc --noEmit                 # проверка типов
```

**Верификационные инварианты** (план):
1. Без аргументов → help
2. Несуществующий файл → stderr, exit ≠ 0
3. Пустой вопрос → `question required`
4. `-s newname` → создаёт сессию, запись в `~/.ocd/sessions.json`
5. `-s newname` повторно → та же сессия (контекст сохраняется)
6. `-s <ses_...>` прямой ID → используется как есть
7. `-p` без буфера → warning, вопрос без clipboard
8. Ответ непустой, не error
9. `--list-sessions` → таблица name/id/messages/updated

**Проверка отсутствия утечек после каждого запуска:**
```bash
pgrep -fl "opencode serve"   # должно быть пусто (или только внешний сервер)
```

## Артефакты проекта

| Файл | Назначение |
|---|---|
| `.omo/plans/ocd-cli-wrapper.md` | Полный план: 11 задач, 3 волны + F1-F4, acceptance-критерии, коммит-стратегия |
| `.omo/drafts/ocd-cli-wrapper.md` | Черновик с зафиксированными решениями (fork point) |
| `.omo/boulder.json` | Состояние выполнения (active_work: ocd-cli-wrapper) |
| `.omo/start-work/ledger.jsonl` | Журнал: DoneClaim + adversarial-классы + cleanup по каждой задаче |
| `src/ocd.ts` | Весь CLI (465 строк) |
| `~/.ocd/sessions.json` | Маппинг имя → sessionID (создаётся автоматически) |

## Правила работы с этим кодом

1. **Не вызывать `process.exit()` внутри try/catch до `finally`** — блокирует cleanup (см. баг 871f328).
2. Ошибки → человекочитаемое сообщение в stderr + exit code ≠ 0, без stack trace для ожидаемых ошибок.
3. Строгий tsconfig: никаких `any`, `@ts-ignore`, `@ts-expect-error`.
4. Стейт пользователя — только в `~/.ocd/`, репозиторий не содержит ничего пользовательского.
5. После каждой задачи: один Conventional-коммит (`feat:`/`fix:`/`chore:`/`build:`/`test:`), только файлы задачи, `.omo/` не коммитить.
6. QA — запуском реального бинарника/скрипта против реального OpenCode; после каждого запуска проверять отсутствие orphan-процессов.
