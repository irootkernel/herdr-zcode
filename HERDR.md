# Global Herdr guide

이 가이드는 현재 작업 디렉터리와 관계없이 모든 프로젝트의 Herdr 작업에 적용한다.
전역 설치 위치는 `/Users/draccoon/HERDR.md`다. 각 CLI의 전역 지침에서 이 파일을 읽게 한다.
관리 원본은 `/Volumes/RootKernel/RootKernel/aquarium-tools/herdr-zcode/HERDR.md`이며,
원본을 수정하면 전역 사본도 갱신한다. 전역 파일은 외장 볼륨 없이도 읽을 수 있는 실제 파일로 둔다.

## 공통 운영 규칙

### 역할

| 역할 | 사용할 agent | 책임 |
| --- | --- | --- |
| Coordinator | Codex, Claude, Gemini | 작업 분해, executor 배정, 진행 확인, 결과 취합 |
| Executor | Coordinator가 선택한 agent | 지정한 범위의 구현, 수정, 조사, 테스트 실행 |
| Evaluator | Codex, Claude, Gemini | 요구사항 충족 여부, 변경 내용, 검증 결과를 독립적으로 평가 |

### Herdr 조작과 pane 배정

Herdr를 조작하기 전에 `/Users/draccoon/.agents/skills/herdr/SKILL.md`를 읽고 따른다.
`HERDR_ENV=1`인 검증된 Herdr 실행 문맥에서 작업한다.

Main tab은 분할하지 않는다. 기존 allocator로 helper pane을 확보한다.
동시에 사용하는 executor마다 서로 다른 안정적인 이름을 정한다.

```sh
dev-herdr --subagent-pane implementation --cwd "$PWD"
dev-herdr --subagent-pane verification --cwd "$PWD"
```

반환된 `.result.pane.pane_id`와 `.result.session`을 사용한다.
Session이 반환되면 이후 Herdr 명령에 같은 `--session`을 붙인다.
기존 pane이 반환되면 그 출력을 읽고 재사용 가능 여부를 확인한다.
동일한 이름의 배정 요청을 새 executor 생성으로 간주하지 않는다.
여러 coordinator가 동시에 작업해도 각 coordinator는 자신의 caller 확인과 allocator 반환값을 사용한다.
다른 coordinator가 얻은 pane ID나 session을 복사해서 사용하지 않는다.

Caller 확인이 실패하면 shared skill의 `dev-herdr --identify-caller` 절차를 따른다.
임의의 pane 생성, 현재 focus, 작업 디렉터리, 상속받은 pane ID만으로 대체하지 않는다.
Probe가 진행 중일 때 다른 agent에게 probe를 공유하거나 다른 화면을 읽지 않는다.

### 작업 요청, 진행 확인과 정리

작업 요청에는 목표, 허용된 파일과 변경 범위, 기존 작업 보존 조건, 완료 조건과 검증을 명시한다.
Executor의 결과 보고에는 변경 파일, 구현 내용, 실제 실행한 테스트와 결과, 남은 문제를 포함한다.
자체 완료 보고나 정상 종료 코드만으로 결과의 정확성을 승인하지 않는다.

Herdr의 idle과 done은 입력 준비 상태이며, unknown은 입력 대기 여부를 확정할 수 없다는 뜻이다.
Timeout만으로 요청이 전달되지 않았다고 판단해 같은 요청을 다시 보내지 않는다.
Coordinator는 결과 보고와 질문을 우선 읽으며, 진행 중에는 필요한 경우 최근 5~10줄 정도로 활동을 확인한다.
문제가 있을 때만 상세 로그를 읽는다. Evaluator는 실제 변경과 필요한 테스트를 확인한다.

각 coordinator는 자신의 executor 목록과 담당 파일을 관리한다.
같은 파일을 함께 수정한다면 담당 범위를 합의하거나 별도 worktree를 사용한다.
Pane과 상태가 분리된다는 사실이 같은 작업 디렉터리의 파일 변경을 격리하지는 않는다.
결과를 읽고 더 이상 재사용하지 않을 helper pane만 닫는다.
다른 helper가 남아 있는 공유 tab과 기존 사용자 session은 보존한다.
설치나 검증 때문에 기존 session을 재시작하거나 live pane의 작업을 교체하지 않는다.

### 기존 session과 running view

재사용 session, login service, running view와 allocator의 상세 동작은
`/Users/draccoon/Workspace/Tools/terminal-conf/HERDR.md`를 따른다.
이 가이드는 해당 도구의 기존 session 구성이나 자동 시작 설정을 대체하지 않는다.

## herdr-zcode v0.1.0: app-server executor

### 역할과 실행 경계

ZCode는 executor로만 사용한다. Herdr 전체 작업 배정이나 독립 evaluator 역할을 맡기지 않는다.
자기 작업 범위 안에서 ZCode의 네이티브 Agent 도구로 subagent와 협업할 수 있으며,
결과 취합과 최종 보고는 상위 ZCode executor가 담당한다. 내부 협업을 위해 `herdr-zcode`를
중첩 실행하거나 `dev-herdr`로 pane을 추가하지 않는다. 외부 executor가 더 필요하면 coordinator에게 요청한다.

- 명령: `/Users/draccoon/.local/bin/herdr-zcode`
- 설치 사본: `/Users/draccoon/.local/lib/node_modules/herdr-zcode/`
- 소스와 가이드 원본: `/Volumes/RootKernel/RootKernel/aquarium-tools/herdr-zcode/`

v0.1.0은 ZCode.app의 app-server를 사용하는 자체 line-oriented 터미널 클라이언트다.
개발 중 0.2.0으로 표기했던 동일한 구현이며, 기능이나 실행 방식은 변경하지 않았다.
누락된 `@zcode/tui`와 기존 개발용 hook plugin을 요구하지 않는다.
예전 hook·launcher·plugin 배포 파일은 저장소에서 제거했으며, 현재 reporter만 상태를 보고한다.
이전 환경의 bridge socket/token을 app-server에 전달하지 않는 방어 처리는 유지한다.
기본 모델은 `account:zai-individual-coding-plan/GLM-5.3`이고 Desktop의 기존 계정을 재사용한다.
Catalog에 정확한 모델이 없으면 오류를 내며 다른 모델로 자동 대체하지 않는다.

### Pane에서 실행하고 작업 전달

Coordinator가 할당한 사용 가능한 shell pane에서 실행한다.
자리표시자는 allocator의 실제 응답으로 바꾸고, 반환된 session이 없으면 `--session`을 생략한다.

```sh
herdr --session <returned-session> pane run <returned-pane-id> 'herdr-zcode --cwd /path/to/project'
herdr --session <returned-session> pane read <returned-pane-id> --source recent-unwrapped --lines 10
```

시작 로그의 실제 세션과 Herdr 입력 준비 상태를 확인한다.
`pane process-info --pane <returned-pane-id>`로 foreground가 실제 wrapper인지 확인한다.
Herdr 0.9.5에서는 custom agent를 rename해도 `agent prompt`가
`not an active named agent`로 거부되므로 입력과 읽기는 pane 명령을 사용한다.

```sh
herdr --session <returned-session> pane send-text <returned-pane-id> '<executor task>'
herdr --session <returned-session> pane send-keys <returned-pane-id> enter
herdr --session <returned-session> pane read <returned-pane-id> --source recent-unwrapped --lines 10
```

전송 성공만으로 모델이 시작·완료됐다고 간주하지 않는다. 상태 변화와 실제 보고를 확인한다.
Timeout 또는 blocked가 반환되면 먼저 상태와 출력을 확인한다. 같은 프롬프트를 무조건 재전송하지 않는다.
입력 준비 확인 없이 coordinator/evaluator가 실행 중인 pane에 wrapper를 시작하지 않는다.
`herdr agent start --kind zcode`나 다른 agent kind로 위장하는 방식은 사용하지 않는다.

긴 작업 설명은 bracketed paste로 한 번에 전달하거나 `--prompt-file /absolute/task.md`로 읽는다.
일반 파이프 입력은 한 줄당 한 턴이므로 여러 줄 문서를 파이프로 보내면 여러 작업으로 나뉜다.
아래의 session과 pane에는 allocator가 검증한 반환값을 사용한다.

```sh
task=$(cat /absolute/task.md)
herdr --session "$session" pane send-text "$pane" "$(printf '\033[200~')${task}$(printf '\033[201~')"
herdr --session "$session" pane send-keys "$pane" enter
```

문서 예시의 ID를 복사하거나 focus로 pane을 추정하지 않는다. 기존 wrapper가 종료되어 shell로 돌아간
pane에는 프롬프트를 보내지 않는다.

### 승인, 질문과 취소

권한 요청 화면에는 도구 이름, 제안된 입력, 선택 가능한 옵션과 내부 요청 출처가 표시된다.
Coordinator는 요청의 실제 내용을 확인하고 기존 승인 경계를 지킨다. 미리 허용되지 않은 사용자 승인을 대신하지 않는다.
Blocked 상태에는 일반 업무 프롬프트가 아니라 해당 요청에 대한 제어 명령을 보낸다.

```sh
herdr --session <returned-session> pane send-text <returned-pane-id> '/allow <request-id>'
herdr --session <returned-session> pane send-keys <returned-pane-id> enter
```

| 입력 | 의미 |
| --- | --- |
| `/allow <id>` | 서버가 제공한 일회성 허용 옵션 |
| `/deny <id>` | 해당 승인 요청이나 질문 거절 |
| `/choose <id> <option>` | 표시된 서버 옵션 선택 |
| `/answer <id> <text>` | 질문에 답변 |
| `/status` | 상태, 대기 입력, 미해결 요청, background 작업 수 |
| `/stop` | 현재 작업 취소 요청과 대기 프롬프트 폐기 |
| `/exit` | 취소·세션 종료·프로세스 정리 후 종료 |

작업 중 Ctrl-C는 app-server 전체를 죽이지 않고 현재 작업을 취소한다.
입력 대기 중 Ctrl-C는 종료한다. SIGTERM/SIGHUP도 정리 경로를 사용한다.
자동 승인 옵션을 덧붙이지 않는다. 기본 native 모드는 `build`다.
특히 `guarded`는 일반 작업을 자동 허용하고 일부 위험 명령만 확인하므로 더 엄격한 모드로 오해하지 않는다.

### 상태와 복수 executor

| 상태 | 해석 |
| --- | --- |
| `idle` 또는 Herdr가 표시하는 `done` | 입력 준비. 평가 통과나 작업 성공 보장은 아님 |
| `working` | 제출·실행 중인 턴 또는 관측된 background 작업 |
| `blocked` | 승인 또는 질문의 응답 필요 |
| `unknown` | 초기화·정리·연결 이상 등 불확실한 실행 상태 |

미해결 interaction이 있으면 다른 도구나 턴의 완료가 blocked를 덮어쓰지 않는다.
상위 session/turn과 내부 subagent의 이벤트를 구분하며 자식 완료를 상위 작업 완료로 취급하지 않는다.
Herdr에는 상위 executor 하나를 표시한다. 내부 subagent는 별도 Herdr pane으로 만들지 않는다.

각 wrapper는 자신의 app-server, 세션, interaction 목록, reporter를 소유한다.
동시에 사용하는 executor마다 별도 pane을 사용한다. 보고는 실제 server socket과 pane 조합으로 제한한다.
Herdr 호출은 비동기이고 최근 상태를 합쳐 전송하며, 장애 시 backoff를 사용한다.
Herdr 장애 동안 표시는 오래된 값일 수 있으므로 필요하면 실제 터미널 출력을 함께 확인한다.

실제 app-server 프로세스의 종료를 관측한 뒤 자신의 Herdr 등록을 해제한다.
다른 executor의 종료나 상태를 변경하지 않는다. SIGKILL이나 시스템 종료에서 정리를 보장하지 않는다.
Herdr 서버 재시작 후 자동 복원은 범위 밖이며, 필요한 대화는 명시적으로
`herdr-zcode --resume <session-id> --cwd /path/to/project`로 재개한다.

### 결과 확인과 가이드 적용

Coordinator는 최종 결과 보고를 읽고, evaluator는 실제 변경 사항과 검증을 독립적으로 확인한다.
작업의 성공 여부와 터미널 입력 준비 상태를 혼동하지 않는다.
실행 결과를 확인하고 재사용하지 않을 helper만 닫으며, 기존 사용자 session은 보존한다.

설치와 CLI 설명은 `README.md`, 재현 가능한 검증 기록은 `docs/verification.md`,
전역 파일에 반영하는 절차와 적용 상태는 `GLOBAL-SETUP.md`를 따른다.
프로젝트의 가이드 원본을 수정했다고 실제 `/Users/draccoon/HERDR.md`까지 갱신된 것은 아니다.
