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
| Модули вместо одного файла | F2: каждый файл <300 строк (было 465 в монолите) |
| Agent-executed QA, без юнит-тестов | Каждый сценарий проверяется запуском реального бинарника |

## Поиск OpenCode (порядок приоритета)

1. `OCD_SERVER_URL` → `createOpencodeClient({ baseUrl })` + probe `session.list()` (ленивый клиент — ошибка всплывает только на первом запросе, поэтому probe обязателен)
2. `OPENCODE_BIN_PATH` → проверка существования файла, префикс dirname в `PATH`, авто-спавн (у `ServerOptions` НЕТ `binPath` — обрабатываем через PATH)
3. дефолт → `createOpencode()` авто-спавн `opencode serve` (cross-spawn ищет в PATH)

## Структура `src/`

| Файл | Строк | Функции | Задача |
|---|---|---|---|
| `ocd.ts` | ~88 | `main()` + commander | T3, T8 |
| `client.ts` | ~65 | `resolveClient`, `closeSpawnedServer` | T4 |
| `sessions.ts` | ~144 | `readMapping`, `writeMapping`, `resolveSession`, `listSessions` | T5 |
| `context.ts` | ~74 | `assembleParts` | T6 |
| `stream.ts` | ~100 | `streamResponse` | T7 |

Порядок в `main()`: args → list-sessions → validate question → **assembleParts** → client → session → stream. Context собирается до спавна сервера, чтобы bad path не оставлял orphans.

## Критичные SDK-факты (проверено по установленному пакету)

- `createOpencode(options?: ServerOptions)` → `{ client, server: { url, close() } }` — спавнит `opencode serve --hostname=X --port=Y`, ждёт строку `opencode server listening on <url>`.
- `createOpencodeClient({ baseUrl, directory })` — **ленивый** fetch-клиент: ошибка соединения только на первом вызове API.
- `client.session.promptAsync({ path: { id }, body: { parts } })` — fire-and-forget; текст приходит через SSE.
- `client.event.subscribe()` → `{ stream: AsyncGenerator }`. События:
  - `message.part.updated` → `{ part: TextPart|ToolPart, delta?: string }` — дельты текста ассистента;
  - `session.status` → `{ status: { type: "idle" } }` — завершение обработки.
- Типы: `TextPartInput = { type: "text", text }`; `FilePartInput` требует URL — **не используется**, контекст всегда TextPartInput.
- Эхо-фильтр: первый message (вопрос пользователя) НЕ выводится; стримим только текст ассистента по `delta`.

## Что сделано (10/11 задач + фиксы; T11 отложен)

| Задача | Коммит | Содержимое | Верификация |
|---|---|---|---|
| T1 package.json | `f5d342b` | deps, скрипты build | ✓ |
| T2 tsconfig.json | `2f0056b` | strict TS | ✓ |
| T3 CLI skeleton | `7369b1c` | commander-парсинг | ✓ |
| T4 client resolver | `a88b9c7` | 3-уровневый discovery | ✓ |
| T5 session manager | `10a7786` | `~/.ocd/sessions.json`, mode 600 | ✓ |
| T6 context assembly | `82e2f23` | clipboard → file/folder → question | ✓ |
| фикс orphans | `871f328` | `exitCode` + exit после finally | ✓ |
| T7 streaming | `c79c895` | promptAsync + SSE | ✓ |
| T8 main integration | `845a518` | `main()`, модули <300 LOC | ✓ |
| T9 build | `445a70e` | 4 target + `install.sh` | ✓ |
| фикс early assemble | `20671e7` | parts до spawn сервера | ✓ |
| T10 QA macOS | `564beb4` | smoke (a)-(g) на darwin-arm64 | ✓ |
| **T11 QA Linux** | — | **отложено**: пользователь прогонит на Linux/Docker сам | ⏭ |

### Final verification (F1–F4)

| Check | Статус | Notes |
|---|---|---|
| F1 Scope IN | ✓ | все паттерны + install.sh; Scope OUT отсутствует |
| F2 Code quality | ✓ | модули, max 144 строк/файл, нет `any`/`@ts-ignore`, `tsc --noEmit` ok |
| F3 Cross-platform | ✓ | 4 бинарника в `dist/`; darwin `--help` ok; linux ELF present |
| F4 Edge cases | ✓ | nonexistent/empty/binary → exit 1; bad `OPENCODE_BIN_PATH` → exit 1; `~/.ocd` mode 700 / sessions.json mode 600; empty clipboard → warning |

### Найденные и исправленные баги

1. **Утечка `opencode serve`** (T6): `process.exit(1)` внутри `catch` блокировал `finally`. Фикс: `exitCode` + exit после finally. **Правило: никогда не вызывать `process.exit` внутри try/catch до finally.**
2. **Спавн сервера на bad path** (T10): `assembleParts` шёл после `resolveClient` → orphan на nonexistent file. Фикс: собирать parts до spawn.

## Как запускать и проверять

```bash
cd /Users/alexantonov/sources/ocd
bun install                       # зависимости
bun run src/ocd.ts "вопрос"      # dev-режим
bun run build                     # бинарник для текущей платформы
bun run build:all                 # 4 кросс-платформенных бинарника
./dist/ocd "вопрос"               # локальный бинарник
./install.sh                      # копирует в ~/.local/bin/ocd
bunx tsc --noEmit                 # проверка типов
```

**Верификационные инварианты**:
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
| `.omo/plans/ocd-cli-wrapper.md` | Полный план: 11 задач, 3 волны + F1-F4 |
| `.omo/drafts/ocd-cli-wrapper.md` | Черновик с зафиксированными решениями |
| `.omo/boulder.json` | Состояние выполнения |
| `src/*.ts` | CLI (модули) |
| `install.sh` | Установка бинарника в `~/.local/bin/ocd` |
| `~/.ocd/sessions.json` | Маппинг имя → sessionID (mode 600) |

## Правила работы с этим кодом

1. **Не вызывать `process.exit()` внутри try/catch до `finally`** — блокирует cleanup (см. баг 871f328).
2. Ошибки → человекочитаемое сообщение в stderr + exit code ≠ 0, без stack trace для ожидаемых ошибок.
3. Строгий tsconfig: никаких `any`, `@ts-ignore`, `@ts-expect-error`.
4. Стейт пользователя — только в `~/.ocd/`, репозиторий не содержит ничего пользовательского.
5. После каждой задачи: один Conventional-коммит (`feat:`/`fix:`/`chore:`/`build:`/`test:`), только файлы задачи, `.omo/` не коммитить.
6. QA — запуском реального бинарника/скрипта против реального OpenCode; после каждого запуска проверять отсутствие orphan-процессов.
