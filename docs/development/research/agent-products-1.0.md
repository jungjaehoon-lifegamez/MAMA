# 비슷한 에이전트 제품의 설치·온보딩·운영·팀 관리 조사

2026-10-15 · 공식 문서, GitHub 저장소와 릴리스 노트를 읽은 조사다. 실행해 본 결과가 아니다. 문서에서
확인하지 못한 것은 "확인 못 함"으로 적었다. 목적은 MAMA OS 1.0의 작업 목록
([v1.md](../work/v1.md))을 정하기 전에 다른 제품이 기본으로 갖춘 것과 MAMA에 없는 것을 나열하는 것이다.

## 조사 대상

| 제품                    | 읽은 버전                                       | 왜 골랐나                                                                    |
| ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| OpenClaw                | 2026.10.3 (stable), 2026.9.33 (extended-stable) | 메신저 뒤에서 늘 도는 개인 에이전트 데몬. MAMA와 형태가 가장 비슷하다        |
| NanoClaw, nanobot       | NanoClaw 버전 표기 없음, nanobot 0.3.5          | OpenClaw의 가벼운 대안                                                       |
| Hermes Agent            | 0.22.2                                          | 메신저 게이트웨이, 기억, 스킬, 예약 작업을 가진 에이전트                     |
| Letta Code              | 0.34.15                                         | 기억 중심 에이전트. V1 서버와 ADE는 폐기되어 비교 대상에서 뺐다              |
| mem0, Zep/Graphiti      | mem0 SDK 2.2.1, Graphiti 0.31.0                 | 기억 제품의 설치와 온보딩. OpenMemory와 Zep Community Edition은 폐기됨       |
| Open WebUI, AnythingLLM | 0.12.2, 1.18.0                                  | 셀프호스팅 팀 AI 작업공간                                                    |
| LibreChat, Khoj         | 0.8.8, 2.0.0-beta.28                            | 같은 범주. Khoj는 2026-03 베타 이후 릴리스가 없어 개발이 멈춘 것으로 본다    |
| Open WebUI Computer     | 버전 표기 없음                                  | Claude Code·Codex CLI 구독을 그대로 쓰는 메신저 에이전트. 형태가 가장 가깝다 |

## 1. 설치

| 플랫폼  | 다른 제품                                                                                                                                                                                | MAMA OS                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | 한 줄 설치 스크립트가 런타임(Node 또는 Python)까지 깔고 바로 온보딩으로 넘어간다(OpenClaw, Hermes, nanobot). 서명된 데스크톱 앱(OpenClaw, Hermes). Homebrew(Letta, AnythingLLM 데스크톱) | Node 22.13 이상을 먼저 설치하고 `npm install -g`. `mama init`이 launchd 파일을 쓰지만 시작은 `launchctl bootstrap`으로 직접 한다 |
| Linux   | 같은 한 줄 스크립트. `gateway install` 한 번으로 systemd 사용자 서비스와 linger까지 설정(OpenClaw, Hermes)                                                                               | 서비스 파일 없이 `start.sh`를 터미널에서 실행. 문서 렌더는 macOS 전용이라 안 되고, LibreOffice와 CJK 폰트는 직접 설치한다        |
| Docker  | 모두 공식 이미지가 있다. 버전 고정 태그, compose 예시, 헬스 체크 주소(OpenClaw `/healthz`·`/readyz`, Hermes 8642, Letta `/readyz`), 볼륨 하나에 데이터를 모은다                          | 없음                                                                                                                             |
| Windows | OpenClaw는 Windows Hub 앱(WSL 배포판을 직접 만듦)·PowerShell·WSL2, Hermes는 PowerShell 한 줄과 MSIX, Letta는 Windows용 패키지                                                            | 지원 안 함. Claude 세션의 셸 샌드박스를 필수로 켜 두어서(`failIfUnavailable`) 네이티브 Windows에서는 셸 도구가 돌지 않는다       |

그 밖에 다른 제품에는 있고 MAMA에는 없는 것:

- 런타임이 없어도 되는 설치(Letta는 Node를 넣은 PyPI 패키지, OpenClaw는 Node 없는 단독 빌드).
- 지원 등급 표(Hermes: Tier 1 macOS·Windows·Linux·WSL2·Docker, Tier 2 Nix·Termux).
- 최소 사양 문서(AnythingLLM 2GB RAM, LibreChat 1GiB RAM 등).

## 2. 온보딩

MAMA OS는 지금 사람이 손으로 하는 단계가 열 개쯤이다. Node 설치, `npm -g`, Claude 또는 Codex 로그인(Codex는
관리용 홈을 지정하는 별도 명령), BotFather에서 봇 만들기, 그룹을 만들고 음수 그룹 ID 찾기, `mama init`,
`config.yaml`에 `member_root` 직접 입력, 자기 텔레그램 숫자 ID를 찾아 `mama register-owner`, `launchctl`로 시작,
`curl /health`로 확인.

다른 제품이 쓰는 방식:

- **기존 로그인 재사용과 실제 호출 확인.** OpenClaw 빠른 시작은 설정된 모델, API 키 환경변수, 설치된 Claude
  Code·Codex CLI를 찾아 그 로그인을 그대로 쓰고, 실제 응답 한 번으로 확인한다.
- **페어링으로 오너 지정.** 등록되지 않은 사람이 봇에 DM을 보내면 8자리 코드(1시간, 최대 3개)를 받고, 운영자가
  터미널이나 웹 화면에서 승인한다. OpenClaw는 처음 승인한 사람이 오너가 된다. 그룹에서 `/whoami`를 보내면 사용자
  ID와 그룹 ID를 알려 준다(OpenClaw, Hermes, Letta, AnythingLLM). OpenClaw의 예전 마법사는 아직 숫자 ID를 묻는다.
- **QR로 봇 만들기.** Hermes 대시보드와 데스크톱 앱은 QR로 텔레그램 봇을 만들고 허용 목록과 설정 파일을 채운 뒤
  게이트웨이를 다시 시작한다.
- **브라우저 첫 실행.** 첫 계정이 관리자가 되고 그 뒤 가입이 닫힌다(Open WebUI, mem0 서버, LibreChat).
  AnythingLLM과 nanobot은 브라우저 설정 마법사가 있다.
- **설정 일부만 다시 하기.** `openclaw configure --section`, `hermes setup model|gateway|tools`, `letta setup`.
  비대화형 옵션(`--non-interactive`)으로 스크립트와 컨테이너에서 설정한다.
- **끝에 점검.** 온보딩 마지막에 헬스 체크나 `doctor`를 돌린다(OpenClaw 예전 마법사, Hermes 문서의 순서).
- **실패하면 복구.** NanoClaw 설치 스크립트는 단계가 실패하면 Claude Code를 불러 원인을 찾고 이어서 진행한다.

MAMA에 이미 있는 것: 오너가 DM에서 버튼으로 사람을 골라 멤버를 등록한다(P7). 멤버는 숫자 ID를 입력하지 않는다.
`mama init`은 비밀값을 화면에 보이지 않게 받고 기존 파일을 덮어쓰지 않는다.

## 3. 운영 명령

| 기능            | 다른 제품                                                                                                                                                                                                | MAMA OS                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 진단            | `doctor [--fix]`(설정 이전, 세션 잠금, 인증 만료, linger, 포트), 읽기 전용 `triage`, 버그 신고용 `status --all`, Hermes `debug share`·`cron doctor`                                                      | 없음. `mama status`는 launchd에 물어 running/stopped만 답한다                                       |
| 업데이트        | `update --dry-run`과 채널 선택(stable·beta), 업데이트 전 스냅숏, 진행 중인 작업이 끝난 뒤 재시작(Hermes 최대 30분), 채팅의 `/update`, 더 새 데이터 위로의 다운그레이드 거부, 매일 새 버전 확인(OpenClaw) | npm 설치, 빌드, 재시작을 손으로 한다                                                                |
| 백업·이전       | `backup create --verify`와 스테이징 복원(OpenClaw), `backup`/`import`(Hermes), 기억 git 저장소의 `backup`·`restore`·`export`(Letta), 다른 에이전트에서 가져오기                                          | 없음. 멤버 내보내기(P9)만 있다                                                                      |
| 삭제            | `uninstall --dry-run`, 서비스·상태·작업 공간을 골라서 삭제                                                                                                                                               | 없음                                                                                                |
| 로그·설정       | `logs --follow`(게이트웨이 연결로 원격에서도), `config get/set/validate/schema`                                                                                                                          | 로그 파일을 직접 연다. 비밀값은 `mama secret set/list`, 나머지 설정은 `config.yaml`을 직접 편집한다 |
| 업그레이드 약속 | AnythingLLM은 하위 호환을 문서로 약속한다. Open WebUI는 롤백해도 DB 마이그레이션은 되돌아가지 않으니 업데이트 전 백업에서 복원하라고 적는다. Letta는 V1 서버를 이전 경로 없이 폐기했다                   | 마이그레이션은 시작할 때 돈다. 이전 릴리스의 DB를 올려 보는 시험은 없다                             |

## 4. 일상 편의

- **채팅 명령.** OpenClaw·Hermes는 CLI와 모든 메신저에서 같은 명령을 쓴다: `/new`, `/stop`, `/status`, `/model`,
  `/usage`, `/whoami`, `/help`, 오너 전용 `/restart`·`/update`. MAMA는 모두 자연어로만 하고, 진행 중인 턴을 채팅에서
  멈출 방법이 없다.
- **사용량과 한도.** OpenClaw는 Claude 5시간·주간 한도와 Codex 한도의 남은 비율을 채팅, CLI, 웹에서 보여 준다.
  Hermes `/usage`, Letta `letta usage`. MAMA는 실행마다 토큰을 기록하지만(W23) 보여 주는 곳이 없다.
- **웹 화면.** OpenClaw Control UI는 대화, 세션, 기기, 설정, 사용량 화면이 있고 22개 언어(한국어·일본어 포함)를
  지원한다. Hermes 대시보드는 설정, 키, 로그, 비용, 예약 작업, 페어링 승인, 채널 설정까지 하고, localhost 밖으로
  열 때는 로그인을 요구한다. MAMA 뷰어는 보드, 작업, 기억 그래프, 위키, 로그, 보안 이벤트를 영어로 읽기만 한다.
- **메신저 수.** OpenClaw·Hermes·Letta는 Telegram 외에 WhatsApp, Signal, Discord, Slack 등을 지원한다. MAMA는
  Telegram만 라이브로 돌렸고 Discord와 Slack은 한 번도 라이브로 돌리지 않았다(W12).
- **모바일·데스크톱.** OpenClaw는 macOS 메뉴 막대 앱, iOS·Android 앱을 QR로 짝짓는다. MAMA는 Telegram이 그 역할을
  한다.
- **스킬 저장소.** ClawHub, Hermes 스킬 허브는 설치할 때 보안 검사를 한다. MAMA는 사람별 스킬(P10.5)만 있다.

## 5. 팀 관리

팀 작업공간이 기본으로 갖춘 것: 첫 계정이 관리자, 초대 또는 승인 대기열, 역할 2~3개와 그룹, OIDC/SSO(Open
WebUI는 SCIM까지 무료), 감사 로그(Open WebUI `AUDIT_LOG_LEVEL`, AnythingLLM Event Logs), 사람별 사용량 분석과
한도, 사람별 내보내기, 브라우저 관리 화면.

MAMA에 있는 것: 오너 역할과 멤버, 텔레그램 버튼으로 등록, 파티션 단위 읽기 권한 부여·회수, 정지·재개·탈퇴,
멤버 내보내기·삭제, 사람마다 따로 도는 세션과 작업 공간. MAMA에 없는 것: 브라우저 관리 화면(관리는 오너의 채팅
요청으로만 한다), 사람별 행동·사용량 화면(`tool_traces`에 기록은 있다), 사람별 사용량 한도.

## 6. 기억 제품에서 볼 것

- Letta는 에이전트마다 기억을 Markdown 파일의 git 저장소로 두고, `memory status|diff|backup|restore|export`와
  `/doctor`(잘못 놓인 기억, 중복, 프롬프트 토큰)를 준다. 최근 대화를 백그라운드에서 기억으로 정리하고, 적용 전에
  검토하게 할 수 있다.
- mem0 서버는 브라우저 마법사(관리자, 모델, 첫 키, 용도 프리셋, 시험 호출)로 시작하고, 사람별 키를 회수할 수 있다.
- Zep은 사실마다 유효 기간 두 개와 출처를 두고, 그래프를 복제해 시험한다.

MAMA는 기록을 고치지 않고 새 수정본을 쌓는다(INTENT). 23시 데일리 턴이 놓친 것을 고치고 어제 교훈을 점검한다
(#502). 기억 상태를 점검하는 명령(중복, 근거 없는 기록, 프롬프트 크기)은 없다.

## 7. MAMA가 앞선 점

- **여러 사람을 위한 상시 에이전트.** AnythingLLM의 텔레그램 봇과 예약 작업은 단일 사용자 모드에서만 된다.
  LibreChat 예약은 실험 기능이라 기본으로 꺼져 있다. OpenClaw는 기본 설정에서 모든 DM이 한 세션을 쓰고, 서로 믿지
  않는 여러 사용자를 위한 것이 아니라고 문서에 적는다. Hermes 문서에서는 여러 사람 모드를 찾지 못했다(프로필은
  에이전트를 나눌 뿐 샌드박스가 아니라고 적는다). MAMA는 사람마다
  세션, 작업 공간, 개인 기록을 따로 두고 공용 그룹을 함께 쓴다.
- **호스트가 막는 개인 기록 보호.** Open WebUI는 관리자가 모든 대화를 볼 수 있고 그것이 보안 경계가 아니라고
  적는다. MAMA는 오너도 멤버의 개인 기록을 읽지 못하게 호스트가 막는다(P6).
- **샌드박스 필수와 관측.** OpenClaw는 샌드박스가 기본으로 꺼져 있다. MAMA는 셸을 샌드박스 안에서만 돌리고,
  막힌 연결과 웹 페이지 열기를 보안 알림으로 남긴다. 사람이 없는 턴은 정해 둔 호스트만 연다(#496).
- **업무 기록.** 업무 소스 감시, 수정 이력이 쌓이는 작업, 비슷한 사례 찾기, 위키, 정기 리포트는 비교한 제품에
  없다.

## 8. 1.0이 뜻한 것

- AnythingLLM 1.0.0(2024-07): 정식 릴리스 주기와 태그를 시작한다는 뜻이었다.
- Khoj 1.0.0(2023-11): 다중 사용자와 Postgres 전환으로 "클라우드 규모"를 준비한 버전이었다.
- Open WebUI와 LibreChat은 아직 0.x다.

  1.0을 안정성 약속으로 쓴 곳은 없었다. MAMA는 오너 결정(2026-10-15)으로 1.0을 "누구나 새로 설치해서 쓸 수 있는
  상태"로 정했다([v1.md](../work/v1.md)).

## 출처

- OpenClaw: https://docs.openclaw.ai/install · /start/getting-started · /start/wizard · /channels/pairing ·
  /channels/telegram/setup · /gateway/doctor · /install/updating · /install/backups · /install/migrating ·
  /install/uninstall · /install/docker · /platforms/windows · /web/control-ui · /concepts/usage-tracking ·
  /tools/slash-commands · /gateway/security · /gateway/sandboxing · https://github.com/openclaw/openclaw/releases
- NanoClaw: https://www.nanoclaw.dev · https://github.com/qwibitai/nanoclaw · nanobot: https://github.com/HKUDS/nanobot
- Hermes Agent: https://github.com/NousResearch/hermes-agent (releases) ·
  https://hermes-agent.nousresearch.com/docs/getting-started/installation/ · /getting-started/platform-support/ ·
  /getting-started/quickstart/ · /getting-started/updating/ · /user-guide/messaging/ · /user-guide/security/ ·
  /user-guide/features/cron/ · /user-guide/features/web-dashboard/ · /user-guide/docker/ · /reference/cli-commands/ ·
  /reference/slash-commands/
- Letta: https://docs.letta.com/quickstart/index.md · /self-hosting/index.md · /concepts/memfs/index.md ·
  /configuration/memory/index.md · /reference/settings/index.md · /self-hosting/channels/telegram/index.md ·
  /teams/permissions/index.md · https://github.com/letta-ai/letta-code
- mem0: https://docs.mem0.ai/open-source/setup · /platform/platform-vs-oss · Zep: https://help.getzep.com/v4/llms.txt ·
  https://github.com/getzep/graphiti
- Open WebUI: https://docs.openwebui.com/getting-started/quick-start/ · /getting-started/updating ·
  /features/authentication-access/rbac/roles · /reference/env-configuration · /ecosystem/computer/install
- AnythingLLM: https://docs.anythingllm.com/installation-docker/overview · /features/security-and-access ·
  /channels/telegram · /scheduled-jobs/overview · https://github.com/Mintplex-Labs/anything-llm/releases/tag/v1.0.0
- LibreChat: https://www.librechat.ai/docs/local/docker · /docs/features/access_control · /docs/features/scheduled_chats
- Khoj: https://docs.khoj.dev/get-started/setup · https://github.com/khoj-ai/khoj/releases/tag/1.0.0
