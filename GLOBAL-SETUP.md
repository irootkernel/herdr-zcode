# 전역 HERDR.md 연결

이 문서는 적용할 설정을 정리한 것이다. 파일이 존재한다는 사실만으로 전역 설치가 완료된 것은 아니다.
`~/HERDR.md`라는 파일명 자체를 모든 CLI가 자동으로 읽는다고 가정하지 않는다.

## 공통 가이드

이 프로젝트의 `HERDR.md`를 `/Users/draccoon/HERDR.md`에 복사한다.
기존 전역 파일이 생겼다면 덮어쓰지 말고 해당 내용을 읽어 병합한다.
외장 볼륨이 없어도 전역 역할 규칙을 읽을 수 있도록 실제 파일을 둔다.
원본을 수정할 때 전역 사본도 갱신한다.

현재 원본에는 여러 coordinator와 여러 executor의 pane 구분, executor별 고유한 할당 이름,
ZCode executor 내부의 네이티브 subagent 허용 범위가 포함돼 있다.
이전 전역 사본을 이미 설치했다면 해당 항목도 병합한다.
ZCode의 executor-only 제한은 Herdr 전체의 coordinator/evaluator 역할에 관한 것이며,
할당된 작업 안에서 네이티브 subagent와 협업하는 것을 금지하지 않는다.

## Codex

기본 `/Users/draccoon/.codex/AGENTS.md`와 현재 활성 프로필인
`/Users/draccoon/.codex-hsy/AGENTS.md`에 아래 항목을 한 번씩 추가한다.
Codex는 `CODEX_HOME`이 설정돼 있으면 그 경로의 전역 지침을 읽는다.
기존 CodeGraph, 임시 파일, Herdr layout 규칙은 보존한다.
Codex에 지원 여부를 확인하지 않은 `@import` 문법을 넣지 않는다.

```md
## Global Herdr policy

Before operating Herdr in any project, read `/Users/draccoon/HERDR.md` and follow it.
ZCode is executor-only. Use Codex, Claude, or Gemini as coordinator and evaluator.
```

## Claude Code

기존 `/Users/draccoon/.claude/CLAUDE.md`에 아래 import를 한 번 추가한다.

```md
@/Users/draccoon/HERDR.md
```

Claude Code의 전역 `CLAUDE.md`와 파일 import 동작은
[공식 memory 문서](https://code.claude.com/docs/en/memory)를 따른다.

## Gemini

Gemini CLI를 사용할 때는 `/Users/draccoon/.gemini/GEMINI.md`에 아래 import를 추가한다.
파일이 이미 있으면 기존 내용을 보존한다.

```md
@/Users/draccoon/HERDR.md
```

Gemini CLI의 전역 경로와 import는
[GEMINI.md 문서](https://geminicli.com/docs/cli/gemini-md/)와
[memory import 문서](https://geminicli.com/docs/reference/memport/)를 따른다.

현재 Mac의 PATH에서 `gemini` CLI는 확인되지 않았고 `agy`는 확인됐다.
Antigravity와 Gemini CLI는 별도 제품이다. Antigravity를 coordinator로 사용할 경우에는
해당 제품의 전역 지침에 다음 읽기 지시를 넣는다.

```md
Herdr 작업 전에 `/Users/draccoon/HERDR.md`를 읽고 따른다.
ZCode는 executor로만 사용하고 coordinator와 evaluator 역할을 배정하지 않는다.
```

## 적용 확인

설정 변경 후 각 CLI의 새 세션에서 전역 가이드가 로드되거나 읽히는지 확인한다.
서로 다른 작업 디렉터리에서도 같은 역할 규칙이 적용되는지 확인한다.
진행 중인 Herdr session을 종료하거나 재시작할 필요는 없다.

## v0.1.0 가이드 갱신

프로젝트의 `HERDR.md`는 app-server 기반 v0.1.0 운영 규칙으로 갱신했다.
개발 중 사용한 0.2.0 표기를 v0.1.0으로 정리했으며, 기능은 그대로 유지한다.
이전 개발용 v0.1.1 사본의 아래 항목은 더 이상 현재 실행 경로에 맞지 않는다.

- native TUI 모듈이 없어 executor로 사용할 수 없다는 설명
- ZCode hook plugin이 필수라는 설치 조건
- Stop hook 때문에 입력 준비를 보고하지 않는다는 상태 정의
- 첫 SessionStart hook과 외부 plugin token을 새 app-server 실행의 상태 근거로 삼는 설명

공통 pane 할당, caller 확인, coordinator/evaluator 역할 규칙은 보존하면서
`## herdr-zcode` 확장 부분을 새 원본과 일치시킨다. 새 버전의 `idle`은 입력 준비 상태이고,
작업의 최종 승인과 품질 평가는 별도 evaluator의 책임이다.
기존 Codex/Claude의 전역 문서 연결은 같은 경로를 가리키므로 중복 추가할 필요가 없다.
Herdr 0.9.5의 custom agent에는 native `agent prompt` 제한이 남아 있으므로,
입력·읽기는 검증된 pane 명령으로 처리하는 새 예시를 사용한다.

## 이 Mac의 적용 상태 — 2026-10-22

이전 설치 작업에서 `/Users/draccoon/HERDR.md`와 기본 Codex, `.codex-hsy`, Claude의
전역 연결이 만들어졌다는 기록과 사용자 확인이 있다. 2026-10-21 작업에서는 DevSpace가
`/Users/draccoon/HERDR.md` 읽기와 `/Users/draccoon` workspace 접근을 모두
`Path is outside allowed roots`로 거부했다.

따라서 해당 작업에서는 v0.1.0 가이드 원본만 갱신했고 전역 사본에는 적용하지 않았다.

2026-10-22에는 사용자 요청에 따라 접근이 허용된 현재 환경에서
`/Users/draccoon/HERDR.md`의 ZCode 부분을 최신 app-server 운영 지침으로 갱신했다.
기존 공통 운영 규칙은 바이트 단위로 보존했으며, ZCode 부분은 관리 원본의
`## herdr-zcode v0.1.0: app-server executor` 이하와 일치하는지 확인했다.
기존 Codex/Claude의 전역 문서 연결은 변경하지 않았다.

CLI 설치 및 실제 app-server/TUI/Herdr 검증은 전역 문서 수정과 별개이며,
정확한 검증 결과와 설치 상태는 `docs/verification.md`에 기록한다.
현재 app-server 기반 v0.1.0에는 hook plugin이 필요하지 않다.
2026-10-21 정리에서 이 Mac의 `herdr-zcode@herdr-zcode-local` 개발용 plugin을 제거하고,
이 plugin만 제공하던 `herdr-zcode-local` marketplace 등록도 제거했다.
plugin 제거에는 `--keep-data`를 사용해 기존 plugin 데이터는 보존했다.
다른 plugin 16개의 설치 버전·활성 상태는 변경 전후 일치하며, 다른 marketplace는 유지했다.
일반 ZCode의 권한·계정 설정, 기존 alias와 진행 중인 session은 변경하지 않았다.
2026-10-21 plugin 정리와 2026-10-22 전역 가이드 갱신은 별도로 수행했다.
