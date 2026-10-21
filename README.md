# herdr-zcode

Herdr에서 ZCode를 executor로 사용하는 경량 app-server 터미널 클라이언트입니다.
`herdr-zcode` v0.1.0은 누락된 `@zcode/tui`를 실행하지 않습니다. ZCode.app의
Electron 런타임과 `zcode.cjs app-server --stdio`를 실행하고, 줄 단위 터미널 UI와
Herdr 상태 보고만 제공합니다. 외부 npm 의존성은 없습니다.

현재 app-server 구현의 버전을 **v0.1.0**으로 정했습니다. 개발 중 사용한 0.2.0 표기만
변경한 것이며, 검증된 기능을 이전 hook 방식으로 되돌린 것이 아닙니다.

```text
Coordinator (Codex / Claude / Gemini)
  -> Herdr executor pane
     -> herdr-zcode terminal client
        -> ZCode app-server -> model / tools / native subagents
```

작업 배정, 스케줄러, 모델 실행 엔진, 별도 데이터베이스를 추가하지 않습니다.
ZCode 내부 Agent 도구의 subagent 사용은 허용하지만, Herdr coordinator와 독립 evaluator는
Codex·Claude·Gemini가 담당합니다.

## 설치와 실행

현재 대상은 ZCode Desktop이 설치되고 Z.AI Individual Coding Plan에 로그인한 macOS입니다.
wrapper는 Node.js 20 이상을 요구하며, 실제 검증 환경의 버전과 결과는
[verification.md](docs/verification.md)에 기록합니다.

```sh
cd /Volumes/RootKernel/RootKernel/aquarium-tools/herdr-zcode
npm install --global --prefix "$HOME/.local" --install-links .
herdr-zcode --version
herdr-zcode --cwd /path/to/project
```

`~/.local/bin`이 PATH에 있어야 합니다. `--install-links`는 로컬 디렉터리를 심볼릭 링크 대신
패키지 사본으로 설치하기 위한 옵션입니다. 설치 사본은 소스 체크아웃과 별개이므로,
소스를 고친 뒤에는 같은 설치 명령으로 갱신합니다. 설치된 패키지는 외장 볼륨의 소스 경로를
import하지 않습니다.

**v0.1.0에서는 ZCode hook plugin이 필요하지 않습니다.** 예전 hook 구현, passthrough launcher,
plugin manifest·marketplace와 전용 테스트·fixture는 저장소에서 제거했습니다.
정식 실행 진입점은 `bin/herdr-zcode-app.mjs`이고, Herdr 상태 보고는 `lib/herdr-reporter.mjs`가 담당합니다.
이전 설치의 환경변수가 남아 있어도 app-server에 bridge socket/token을 전달하지 않는 방어 코드와
그 회귀 테스트는 유지합니다. 다른 ZCode plugin과 사용자의 기존 `zcode` alias는 변경하지 않습니다.

## 모델과 계정

기본 모델 식별자는 `account:zai-individual-coding-plan/GLM-5.3`입니다.
사용자가 부르는 GLM 5.3 Max의 화면 이름을 프로토콜 ID로 추측하지 않고, catalog의 정확한 ID와
advertised reasoning 기본값을 확인합니다. 다른 모델로 조용히 대체하지 않습니다.

```sh
herdr-zcode --model account:zai-individual-coding-plan/GLM-5.3
herdr-zcode --app-bundle /path/to/ZCode.app
```

Mulgae에서 사용하는 최소 계정 연결 계약을 포팅했습니다.

- Desktop v2 설정과 기존 coding-plan credential을 읽습니다. 새 API key를 요구하거나 저장하지 않습니다.
- 공개 provider catalog만 실행별 임시 파일로 복사하고 Built-in/Personal 경로를 함께 고정합니다.
  revision에는 실제 catalog 경로의 digest를 사용하므로 특정 앱 버전·CPU·endpoint cache 경로를 하드코딩하지 않습니다.
- provider 계정 overlay를 등록하고 catalog에 있는 모델을 선택한 다음 실제 선택 결과를 확인합니다.
- 인증은 일치하는 provider/account-access 역방향 요청에만 반환합니다. 계정이 바뀌면 기존 실행은 재시작이 필요합니다.
- Desktop credential, model 기본 설정, 개인 provider 설정은 wrapper가 쓰지 않습니다.
  stdio의 인증 요청/응답과 원본 provider 오류·헤더·쿠키·stack은 터미널에 출력하지 않습니다.

## 터미널 사용

프롬프트를 입력하고 Enter를 누릅니다. 실행 중 새 프롬프트는 같은 세션의 다음 턴으로 대기하며,
아래 제어 명령은 턴이 끝날 때까지 기다리지 않고 처리합니다.

| 명령 | 동작 |
| --- | --- |
| `/help` | 명령 안내 |
| `/status` | 현재 상태, 대기 입력, 미해결 요청, background 작업 수 |
| `/stop` | 현재 작업의 취소 요청, 대기 프롬프트 폐기 |
| `/exit` | 미해결 요청을 거절하고 세션·프로세스를 정리한 뒤 종료 |
| `/allow <id>` | 서버가 제공한 일회성 허용 옵션 선택 |
| `/deny <id>` | 해당 승인 요청 또는 질문 거절 |
| `/choose <id> <option>` | 화면에 표시된 서버 옵션 선택 |
| `/answer <id> <text>` | 질문에 답변 |

여러 질문에는 `/answer <id> {"질문 문구":"답변",...}` 형식을 사용할 수 있습니다.
승인 화면에는 도구 이름뿐 아니라 제안된 입력과 내부 subagent 출처를 표시합니다.
`/allow`는 일회성 옵션만 선택하며, 영구 규칙 등 다른 옵션은 명시적으로 `/choose`로 선택해야 합니다.

작업 중 Ctrl-C는 app-server를 종료하지 않고 작업을 취소합니다. 입력 대기 중 Ctrl-C는 종료합니다.
SIGTERM/SIGHUP은 정리 후 종료하며, app-server 종료를 관측한 뒤에만 Herdr 보고를 해제합니다.
정리 timeout은 성공적인 취소로 간주하지 않습니다.

### 긴 프롬프트와 스크립트 입력

```sh
herdr-zcode --cwd /path/to/project --prompt-file /path/to/task.md
printf '첫 번째 작업\n두 번째 작업\n' | herdr-zcode --cwd /path/to/project
```

터미널의 bracketed paste는 여러 줄을 하나의 프롬프트로 유지합니다. 파일 입력도 한 턴으로 전달합니다.
일반 파이프 입력은 한 줄당 한 턴입니다. EOF는 이미 제출했거나 대기 중인 작업이 끝난 뒤 종료합니다.
EOF 이후 필요한 승인은 자동 허용하지 않고 거절합니다. 즉시 취소하고 종료하려면 `/exit`를 사용합니다.

### 세션과 권한 모드

```sh
herdr-zcode --resume <session-id> --cwd /path/to/project
herdr-zcode --mode build
```

기본은 native `build` 모드입니다. 별도 자동 승인 옵션을 몰래 추가하지 않습니다.
사용자가 명시한 native mode를 전달하므로 `guarded`, `edit`, `yolo`, `auto`의 의미는 ZCode에 따릅니다.
특히 현재 ZCode의 `guarded`는 일반 작업을 자동 허용하고 일부 위험 명령만 확인하는 방식이므로,
모든 변경을 확인하는 `build`보다 엄격한 모드라고 생각하면 안 됩니다.
자동 Herdr 서버 재시작/세션 복원은 이 wrapper의 범위가 아니며 `--resume`은 명시적인 재개입니다.

## Herdr 연결

실제 Herdr pane에 주입된 `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`가
모두 있을 때만 보고합니다. Herdr 밖에서도 터미널 클라이언트는 동작합니다.
서버 socket과 pane 조합을 고정하며, 각 executor는 별도 app-server·세션·상태를 가집니다.
기존 pane allocator와 coordinator별 전용 helper tab 운영 규칙은 [HERDR.md](HERDR.md)에 있습니다.

| 상태 | 의미 |
| --- | --- |
| `idle` | 다음 입력을 받을 준비가 됨. 평가 통과를 뜻하지 않음 |
| `working` | 제출/실행 중인 턴 또는 알려진 background 작업이 있음 |
| `blocked` | 승인이나 질문의 응답이 필요함. 다른 도구 완료로 해제되지 않음 |
| `unknown` | 초기화, 종료, 연결 이상 등 실행 상태가 확정되지 않음 |

Herdr 보고는 비동기이며 진행 중인 보고가 있으면 가장 최근 상태만 남깁니다.
짧은 timeout과 backoff를 적용하여 Herdr 장애가 모델·입력을 계속 지연시키지 않게 합니다.
관측된 턴/세션 ID와 미해결 interaction을 기준으로 상태를 계산하며, 내부 subagent의 종료를
상위 executor 전체의 완료로 처리하지 않습니다.

`herdr agent start --kind zcode` 대신 이미 할당된 shell pane에서 `herdr-zcode`를 실행합니다.
**Herdr 0.9.5는 custom agent의 상태를 표시하지만 `agent prompt`는 `not an active named agent`로 거부합니다.**
이름을 붙여도 동일하며 다른 builtin agent로 위장하지 않습니다. 입력과 읽기는 `pane` 명령을 사용합니다.

```sh
# allocator가 반환한 실제 session/pane을 사용합니다.
herdr --session "$session" pane process-info --pane "$pane"
herdr --session "$session" pane read "$pane" --source recent-unwrapped --lines 10
# foreground가 실제 herdr-zcode이고 입력 준비 상태인지 확인한 뒤 전송합니다.
herdr --session "$session" pane send-text "$pane" '작업 프롬프트'
herdr --session "$session" pane send-keys "$pane" enter
```

여러 줄은 한 paste boundary로 감싸거나 처음 실행할 때 `--prompt-file`을 사용합니다.

```sh
task=$(cat /absolute/task.md)
herdr --session "$session" pane send-text "$pane" "$(printf '\033[200~')${task}$(printf '\033[201~')"
herdr --session "$session" pane send-keys "$pane" enter
```

전송 성공은 모델 처리 완료가 아닙니다. 상태 변화와 실제 결과 보고를 확인합니다.
권한 또는 질문 화면에는 일반 작업 프롬프트 대신 `/allow`, `/deny`, `/choose`, `/answer`를 보냅니다.
같은 파일을 여러 executor가 수정하는 충돌까지 pane 분리가 해결하지는 않으므로 작업 범위를 나눠야 합니다.

## 검증

```sh
npm test
npm run test:live-account
npm run test:live-reporter
npm run test:live-herdr -- --scenario basic
npm run test:live-herdr -- --scenario permissions
npm run test:live-herdr -- --scenario subagent
npm run test:live-herdr -- --scenario question
npm run test:live-herdr -- --scenario cancel
npm run test:live-herdr -- --scenario multiline
npm run test:live-herdr -- --scenario resume
npm run test:live-herdr -- --scenario coding
```

현재 회귀 테스트는 **104개**입니다. 기존 120개 중 삭제한 hook bridge 전용 테스트 16개를 제외한 수이며,
app-server와 현재 reporter의 테스트 범위는 그대로 유지합니다.
2026-10-21 구현 검증에서는 설치된 명령을 통한 실제 Herdr/model 시나리오 8개가 모두 통과했습니다.
계정 연결의 실제 2턴 응답, 한국어 파이프 입력, 4개 reporter의 독립 상태·종료도 별도로 확인했습니다.
정리 후 재검증 결과와 과거 120개 통과 기록은 [verification.md](docs/verification.md)를 확인하세요.

`npm test`는 가짜 app-server/Herdr와 임시 credential로 실행하여 실제 계정 사용량을 쓰지 않습니다.
새 app-server entrypoint, 양방향 RPC, 입력/EOF, 승인/거부/질문, 취소/종료, 동시 executor,
모델/catalog, reporter 장애·복구를 별도로 검증합니다. 현재 `npm test`는 app-server 방식의
테스트만 실행하며, 과거 hook 방식의 테스트나 fixture에 의존하지 않습니다.

`test:live-*`는 명시적으로 실행할 때만 실제 ZCode 또는 Herdr를 사용합니다.
Herdr 검증은 고유한 disposable named session과 테스트 소유 디렉터리를 만들고,
사용자의 기존 session·pane을 조회하거나 재시작하지 않고 자체 자원을 정리합니다.
실제 모델, 실제 Herdr, 모의 검증의 구분과 결과는 [verification.md](docs/verification.md)를 확인하세요.

## 전역 가이드

[GLOBAL-SETUP.md](GLOBAL-SETUP.md)는 각 CLI의 전역 지침에서 `/Users/draccoon/HERDR.md`를
읽도록 연결하는 절차입니다. [HERDR.md](HERDR.md)는 관리 원본이며, 원본 수정과 전역 사본 적용은
별도 작업입니다. 전역 파일 접근이 허용되지 않으면 적용됐다고 보고하지 않습니다.

## 구현 범위

Node 표준 라이브러리 기반 line-oriented UI이며, ZCode Desktop 화면 전체를 복제하지 않습니다.
Browser/Computer Use 같은 별도 Desktop host 기능이나 모든 선택적 host RPC를 구현하지 않습니다.
지원하지 않는 역방향 요청에는 명시적인 오류를 반환하며 승인이나 인증을 임의로 대신하지 않습니다.
일반적인 코드 구현·도구 실행·네이티브 subagent·질문/승인을 처리하는 executor 경로가 대상입니다.

주요 코드: `app-server-client.mjs`(전송), `app-server-controller.mjs`(상태/입력),
`desktop-runtime.mjs`와 `desktop-account.mjs`(Desktop 연결), `herdr-reporter.mjs`(상태 보고).
