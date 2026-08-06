# AGENT.md — ocd: CLI-обёртка над OpenCode

Последнее обновление: 2026-08-06.

## Что это

**ocd** — консольная утилита (одна строка в терминале), которая принимает один вопрос и потоково выводит ответ OpenCode в stdout. Альтернатива `opencode` для быстрых одноразовых запросов.

```bash
ocd "что такое 2+2?"                    # простой вопрос
ocd file.ts "отрефактори"               # файл как контекст (parent = workspace)
ocd folder/ "что здесь?"                # папка = OpenCode working directory
ocd -p "объясни"                        # текст из буфера обмена
ocd -s auth "продолжи"                  # именованная сессия (создать/возобновить)
ocd -l                                  # список именованных сессий
ocd -v "вопрос"                         # + reasoning и tool-вызовы в stderr
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
| Дефолт `http://127.0.0.1:4097` (+ `OCD_SERVER_URL`) | Свой pure-serve; порт 4096 (TUI/IDE) не трогаем |
| Persistent daemon на первом запуске | Cold start один раз; дальше быстрый connect |
| Гибрид файлов (≤4KB inline) | Малые файлы в prompt; большие — path + hint для tools |
| Папка = `directory`, не listing | OpenCode сам видит workspace; в prompt листинг не кладём |
| `clipboardy` | Кроссплатформенный доступ к буферу обмена |
| Модули вместо одного файла | Читаемость; бюджет ~300 LOC/файл желателен, не жёсткий |
| Agent-executed QA, без юнит-тестов | Каждый сценарий — запуском реального бинарника |

## Поиск OpenCode (порядок приоритета)

1. `OCD_SERVER_URL` или дефолт `http://127.0.0.1:4097` → connect + probe `session.list()`
2. Если дефолт мёртв → **один раз** поднять persistent `opencode serve --hostname=127.0.0.1 --port=4097 --pure` (detached, **не** убиваем при выходе `ocd`)
3. Явный `OCD_SERVER_URL` при ошибке → fail (без автостарта)
4. Last resort → ephemeral `--pure` на port 0 (**убивается** при выходе)

После первого успешного запуска daemon на `:4097` остаётся жить — это нормально.

## Структура `src/`

| Файл | Строк | Функции | Задача |
|---|---|---|---|
| `ocd.ts` | ~119 | `main()` + commander | T3, T8 |
| `client.ts` | ~298 | `resolveClient`, daemon/ephemeral spawn, abort hooks | T4 |
| `sessions.ts` | ~144 | `readMapping`, `writeMapping`, `resolveSession`, `listSessions` | T5 |
| `context.ts` | ~137 | `resolveWorkspace`, `assembleParts` | T6 |
| `stream.ts` | ~273 | `streamResponse` (+ delta/role race, flush) | T7 |

Порядок в `main()`: args → list-sessions → validate question → **resolveWorkspace + assembleParts** → client → session → stream. Context собирается до connect/spawn, чтобы bad path не поднимал сервер.

## Критичные SDK-факты

- `createOpencode(options?)` → `{ client, server: { url, close() } }` — ephemeral serve; для `:4097` мы спавним `opencode serve --pure` сами.
- `createOpencodeClient({ baseUrl, directory })` — ленивый клиент; ошибка только на первом API-вызове.
- `client.session.promptAsync(...)` — fire-and-forget; текст через SSE.
- `client.event.subscribe()` → `{ stream }`. Важные события:
  - `message.updated` — `role` (`user`/`assistant`); часто **после** текста ассистента;
  - `message.part.updated` — part + опциональный `delta`;
  - `message.part.delta` — `{ sessionID, messageID, partID, field, delta }` (в SDK 1.18 типов может не быть — обрабатываем runtime);
  - `session.status` / `session.idle` — завершение.
- Эхо-фильтр: пропускаем только известные `user` messages; неизвестный role + text parts печатаем (иначе пустой stdout).
- Контекст: папка → OpenCode `directory`; файл → `directory` = parent + гибрид (≤4KB inline / path-only).
- Tool/reasoning в stderr только при `-v` или `OCD_VERBOSE=1|true` (ответ — stdout). Tools: start+args, done+output (усечённо), error.

## Что сделано (10/11 задач + пост-фиксы; T11 отложен)

| Задача | Коммит | Содержимое | Верификация |
|---|---|---|---|
| T1–T10 | см. историю | core CLI, build, macOS QA | ✓ |
| фикс hang headless | `498ab54` | `--pure`, title, SSE до prompt, timeout | ✓ |
| hybrid files | `85c8392` / `f30764b` | inline ≤4KB | ✓ |
| workspace directory | `e499ad9` | папка/файл → OpenCode `directory` | ✓ |
| abort / SIGINT / role filter | `2d65317` | cleanup + assistant filter | ✓ |
| default `:4097` | `bfce60b` | `DEFAULT_SERVER_URL` | ✓ |
| persistent daemon | `921a2a0` | auto-start `--pure` на 4097 | ✓ |
| empty SSE text | `f97486e` | late role + `message.part.delta` + flush | ✓ |
| **T11 QA Linux** | — | **отложено**: пользователь прогонит сам | ⏭ |

### Final verification (F1–F4)

| Check | Статус | Notes |
|---|---|---|
| F1 Scope IN | ✓ | паттерны + install.sh; Scope OUT отсутствует |
| F2 Code quality | ✓ | модули, нет `any`/`@ts-ignore`, `tsc --noEmit` ok |
| F3 Cross-platform | ✓ | 4 бинарника в `dist/` |
| F4 Edge cases | ✓ | bad path/empty/binary/OPENCODE_BIN_PATH; `~/.ocd` 700 / sessions 600 |

### Найденные и исправленные баги

1. **Утечка `opencode serve`** (ephemeral): `process.exit` до `finally` блокировал cleanup. **Правило: не вызывать `process.exit` внутри try/catch до finally.**
2. **Спавн на bad path**: parts после client → orphan. Фикс: assemble до connect.
3. **Hang на headless**: OhMyOpenCode / title-agent. Фикс: `--pure` + session title + timeout/abort.
4. **Пустой stdout**: `role=assistant` приходит после текста; `message.part.delta` игнорировался. Фикс: `f97486e`.

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
9. `-l` / `--list-sessions` → таблица name/id/messages/updated
10. Без `-v` reasoning/tool в stderr нет; с `-v` / `OCD_VERBOSE=1` — есть (stdout чистый)

**Процессы OpenCode после запуска:**
```bash
pgrep -fl "opencode serve"
# Ожидаемо: persistent daemon на :4097 (после первого auto-start) — OK
# Неожиданно: лишние ephemeral serve (port=0) после выхода ocd — баг
lsof -nP -iTCP:4097 -sTCP:LISTEN   # должен быть один listener
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

## Env

| Переменная | Смысл |
|---|---|
| `OCD_SERVER_URL` | Явный сервер; при ошибке — fail, без auto-start |
| `OPENCODE_BIN_PATH` | Путь к бинарнику `opencode` |
| `OCD_VERBOSE` | `1` / `true` — reasoning + tool-вызовы в stderr (как `-v`) |

## Правила работы с этим кодом

1. **Не вызывать `process.exit()` внутри try/catch до `finally`** — блокирует cleanup.
2. Ошибки → человекочитаемое сообщение в stderr + exit code ≠ 0, без stack trace для ожидаемых ошибок.
3. Строгий tsconfig: никаких `any`, `@ts-ignore`, `@ts-expect-error`.
4. Стейт пользователя — только в `~/.ocd/`, репозиторий не содержит ничего пользовательского.
5. После каждой задачи: один Conventional-коммит, только файлы задачи, `.omo/` не коммитить.
6. QA — реальным бинарником против реального OpenCode; ephemeral orphans недопустимы; persistent `:4097` — ожидаем.
7. Persistent daemon на `:4097` не убивать из `closeSpawnedServer()`.
