# 纸质展品光照额度管理（Light Quota）

面向纸本、拓本等光敏展品的**年度照度时数（剂量，单位 lx·h）额度管理** Web 应用。
Node.js（Express）+ PostgreSQL，本地账号区分两类角色：

- **保管员（conservator）**：登记展品与每年照度时数上限、批准/驳回/复核布展计划、审核计划调整申请、录入并确认实测。
- **布展员（installer）**：创建展出计划（展期、每日开灯时段、预计照度）、对已批准且未开始的计划提交/撤回调整申请、查看额度占用。

## 核心业务规则

1. **按自然年拆分剂量**：以墙上时间（默认中国标准时间 UTC+08:00，固定偏移不处理夏令时）归属年份。
   - 每日开灯时段支持多段、支持跨午夜（如 `20:00-02:00`）；计划可以跨年，剂量自动切到各自然年。
2. **时间重叠不得批准**：同一展品，两条已批准/待复核计划只要**开灯时刻区间相交**即拒绝批准
   （即使展出日期有重叠但开灯时段不相交，也允许）。
3. **批准时合计校验**：
   `已确认实测剂量` + `其他已批准/待复核计划尚未被实测覆盖部分的估算剂量` + `本计划估算剂量`，
   任一自然年超过该展品年度上限即拒绝，并在错误信息与页面中列出**超限年份、上限、各部分占用与超额量（lx·h）**。
4. **并发安全**：批准/确认事务先对展品行加 `SELECT ... FOR UPDATE` 行锁，串行化同展品的并发批准，防止超配。
5. **实测替代估算**：展后保管员在「已批准计划的开灯时段内」录入实测时段与照度，确认后该时段改按实测计量，
   原估算的对应部分自动扣除；已确认测量记录与审批记录保留（不可修改/删除）。
6. **重叠实测拒绝**：实测时段与同展品任何未作废实测时间相交即拒绝（含待确认记录）。
7. **迟到实测导致超限**：确认实测若使某展品某自然年已用剂量超限，
   该展品在**相应年度仍有估算剂量、且尚未开始**的已批准计划自动转为 **待复核（pending_review）**，
   页面展示原因；保管员复核通过时重新执行完整的重叠+额度校验。原审批与测量记录均保留。
8. **校验报错**：非法日期/时间、零时长或互相重叠的开灯时段、非正照度/上限等一律返回明确中文错误。
9. 页面按展品展示**每个自然年的上限、已占用、剩余额度**，以及逐条占用来源
   （已确认实测、各计划估算残余，含按年剂量）。
10. **计划调整申请**：布展员可对「已批准且尚未开始」的计划提交调整申请（新展期、新每日开灯时段、新预计照度）。
    - 同一计划同时只允许**一份待审申请**；撤回或被驳回/拒绝后可重新提交。
    - **待审期间原计划继续占用额度**，计划本身不变；展品详情同时展示原值与拟改值及试算结果。
    - 保管员**批准时在展品锁事务内重新核对**：计划仍已批准且未开始；该计划所有**未作废实测（含待确认）都落在新开灯窗内**；
      新窗口不与同展品其他**已批准/待复核**计划重叠；并按自然年以「新窗口未被已确认实测覆盖部分」的估算量**替换原剩余估算量**，
      任一年超年度上限即拒绝。核对通过才**原子更新计划并写审计**；驳回不改变计划。
    - 核对失败（409）会在错误信息与结构化 `details` 中指出**冲突计划、窗外实测、超额年份与各项数值**，
      申请**保持待审**，布展员可撤回后修改重提（也可在提额后由保管员直接批准原申请）。
11. **下调年度上限（预演 + 凭证）**：保管员下调某展品某自然年的照度时数上限前，可凭「展品、年份、拟定正数上限」**预演**：
    - 预演**不改任何状态**，返回一次性**预演凭证**（30 分钟有效）与核算结果：该年**已确认实测**、
      各**已批准/待复核计划的估算残余**、**预计超额量**，以及超额时「仍有该年估算残余且尚未开始」的已批准计划
      （这些计划将在下调成功后转为待复核；**已开始计划不转状态**，剩余超额仍如实显示）。
    - **携凭证提交**时，服务端在同一展品锁事务内校验：凭证有效、提交字段与预演一致、且预演后**额度或相关占用未变化**
      （占用状态指纹：年度上限、已批准/待复核计划窗口、已确认实测）。任一不满足返回 **409** 并给出**最新预演结果与新凭证**。
    - **不携凭证（沿用旧请求字段直接修改）** 仍然支持：在同一事务内**即时重算**。
    - 下调成功在同一事务内**原子更新上限**、**保留原审批与实测**，把本次核算列出的未开始计划**转为待复核并写明原因**；
      不删除任何占用、不自动取消计划。后续复核沿用现有**重叠 + 额度**校验。
    - 额度查询与修改的成功响应**保持兼容**（修改响应在原展品详情结构上额外附加 `limitChange`）。

## 一键启动（Docker Compose）

前置：已安装 Docker 与 Docker Compose（v2）。

```bash
cd <本项目目录>
docker compose up --build -d
```

启动后访问：

- **应用地址：http://localhost:3000**
- PostgreSQL 仅映射到本机：`localhost:5432`（排查用，可在 compose 中删除 ports 段）

首次启动会自动：建表 → 创建两个默认账号 → 写入一个演示展品与一条跨年已批准计划（可用 `SEED_DEMO=false` 关闭）。

默认账号（**请在生产环境修改**）：

| 角色 | 用户名 | 密码 |
| --- | --- | --- |
| 保管员 | `custodian` | `guard123` |
| 布展员 | `installer` | `setup123` |

停止与清理：

```bash
docker compose down          # 停止（保留数据卷）
docker compose down -v       # 停止并删除数据库数据卷（完全重置）
docker compose logs -f app   # 查看应用日志
```

## 配置（环境变量）

可在项目根目录放 `.env`（参考 `.env.example`），或 `docker compose up` 前在 shell 中导出：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 宿主机映射端口（容器内固定 3000） |
| `DB_PORT` | `5432` | PostgreSQL 映射到宿主机的端口 |
| `PGHOST` | `db` | 数据库主机（Compose 内置网络中的服务名） |
| `PGPORT` | `5432` | 数据库端口 |
| `PGDATABASE` | `lightquota` | 数据库名 |
| `PGUSER` | `lightquota` | 数据库用户 |
| `PGPASSWORD` | `lightquota_secret` | 数据库密码 |
| `TZ_OFFSET_MINUTES` | `480` | 墙上时间相对 UTC 的固定偏移（分钟），中国为 480 |
| `SEED_CONSERVATOR_USERNAME` / `SEED_CONSERVATOR_PASSWORD` | `custodian` / `guard123` | 初始保管员账号（仅首次初始化时创建） |
| `SEED_INSTALLER_USERNAME` / `SEED_INSTALLER_PASSWORD` | `installer` / `setup123` | 初始布展员账号 |
| `SEED_DEMO` | `true` | 是否写入演示展品/计划 |

修改账号相关变量后若库中已存在同名用户不会重复创建；需要重置初始数据可 `docker compose down -v` 后重新启动。

## 本地（非 Docker）运行

```bash
npm install
# 准备一个可访问的 PostgreSQL，然后设置 PG* 环境变量（PGHOST 默认指向 compose 的 db）
PGHOST=127.0.0.1 PGUSER=lightquota PGPASSWORD=lightquota_secret npm start
```

核心剂量算法的离线自测（不需要数据库）：

```bash
npm run test:utils
```

## 使用流程

1. 保管员登录 → 「展品与额度」登记展品，并为相关自然年登记年度上限（lx·h）。
2. 布展员登录 → 「布展计划」选择展品、填展期、每日开灯时段（每行一段 `HH:MM-HH:MM`）、预计照度后提交；
   提交时即检查与已批准计划的开灯时间重叠。
3. 保管员在展品详情中查看按年预计剂量，执行批准/驳回；超限时会列出年份与超额量。
4. 展后保管员在「实测记录」录入已批准计划内的实测时段与照度 → 确认；
   若迟到实测造成年度超限，相应未开始计划转待复核，保管员在详情页复核。
5. 计划尚未开始时，布展员可在「布展计划」对该计划点「申请调整」，改填展期/开灯时段/照度后提交；
   保管员在计划行内查看原值与拟改值对照及核对结果，选择「批准调整」或「驳回」；布展员可撤回自己的待审申请后重提。
6. 保管员在展品详情中**下调年度上限**时，先输入年份与拟定上限点「预演下调」查看只读核算（凭证、已确认实测、
   各计划估算残余、预计超额、将转待复核的未开始计划），再「携凭证确认下调」；预演后若占用变化会返回 409 与最新预演。
   也可「直接保存上限」（同一事务即时重算）。下调后未开始计划转待复核，原审批/实测保留，复核沿用既有重叠+额度校验。
7. 「操作流水」保留全部审批、调整、确认、上限下调、状态变更等记录。

## HTTP API（含计划调整申请）

所有接口除 `/api/health`、`/api/auth/login` 外都需要登录会话（HttpOnly Cookie `lqsession`）。
统一错误形态：`{ "error": "中文原因", "details": { ... } }`，409 用于冲突（重叠/超额/重复申请）。

### 认证

```bash
# 登录（保存 Cookie）
curl -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"installer","password":"setup123"}'

curl -b cookies.txt http://localhost:3000/api/auth/me
curl -b cookies.txt -X POST http://localhost:3000/api/auth/logout
```

### 既有接口（响应保持兼容，计划对象额外附加调整字段）

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `GET  /api/exhibits` | 登录 | 展品列表 + 年度额度概况 |
| `POST /api/exhibits` | 保管员 | 登记展品 |
| `GET  /api/exhibits/:id` | 登录 | 展品详情：按年额度、占用来源、计划（计划行内联 `pendingAdjustment`）、实测 |
| `POST /api/exhibits/:id/limits` | 保管员 | 登记/修改某自然年上限（可携 `previewToken`；成功响应额外附加 `limitChange`，其余结构兼容） |
| `POST /api/exhibits/:id/limits/preview` | 保管员 | **下调预演（只读）**：返回凭证 `previewToken` + 该年实测/计划残余/预计超额/待复核候选 |
| `GET  /api/plans?exhibitId=` | 登录 | 计划列表（附加 `notStarted`、`pendingAdjustment` 概要） |
| `POST /api/plans` | 布展员 | 创建计划 |
| `GET  /api/plans/:id` | 登录 | 计划详情（待审申请带 `preview` 原值/拟改值试算） |
| `POST /api/plans/:id/approve` | 保管员 | 批准 / 复核通过 |
| `POST /api/plans/:id/reject` | 保管员 | 驳回落计划 |
| `POST /api/plans/:id/cancel` | 登录 | 取消（布展员仅自己未批准的；保管员均可） |
| `GET/POST /api/measurements`、`POST /api/measurements/:id/confirm`、`DELETE /api/measurements/:id` | 保管员 | 实测录入/确认/删草稿 |
| `GET /api/audit` | 保管员 | 操作流水 |

### 计划调整申请 `/api/adjustments`

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/adjustments` | 布展员 | 对已批准且未开始的计划提交调整申请（每计划至多一份待审） |
| `POST /api/adjustments/preview` | 布展员 | 仅试算拟改值，不写库 |
| `GET  /api/adjustments?planId=&exhibitId=&status=&preview=1` | 登录 | 申请列表/历史，带原值 |
| `GET  /api/adjustments/:id` | 登录 | 申请详情（待审带试算） |
| `POST /api/adjustments/:id/approve` | 保管员 | 批准：锁事务内重新核对，通过则原子更新计划 |
| `POST /api/adjustments/:id/reject` | 保管员 | 驳回（计划不变），body 可带 `reason` |
| `POST /api/adjustments/:id/withdraw` | 布展员本人/保管员 | 撤回待审申请，之后可重新提交 |

提交申请（`POST`）请求体：

```json
{
  "planId": 12,
  "startDate": "2030-12-31",
  "endDate": "2031-01-02",
  "periods": ["09:00-12:00", "13:00-17:00"],
  "estimatedLux": 120,
  "reason": "配合跨年活动改期（可选）"
}
```

curl 调用示例（布展员提交 → 保管员核对 → 批准/驳回/撤回）：

```bash
# 1) 布展员提交调整申请（响应里的 preview 为即时试算；申请为 pending）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"planId":12,"startDate":"2030-12-31","endDate":"2031-01-02",
       "periods":["09:00-12:00","13:00-17:00"],"estimatedLux":120}'

# 2) 查看申请（原值 original + 拟改值 + preview.conflicts/yearlyReport）
curl -b cookies.txt http://localhost:3000/api/adjustments/1

# 3a) 保管员批准：成功返回更新后的展品详情
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/approve

# 3b) 保管员驳回（计划不变）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/adjustments/1/reject \
  -H 'Content-Type: application/json' -d '{"reason":"与邻厅计划冲突"}'

# 3c) 布展员撤回（之后可用同一 planId 重新提交）
curl -b cookies.txt -X POST http://localhost:3000/api/adjustments/1/withdraw
```

批准核对失败时返回 **409**，申请保持 `pending`，`details.conflicts` 给出全部冲突：

```json
{
  "error": "调整申请 #1 未通过核对：与同展品已批准计划「夜场」(#7) 开灯时间重叠；2031 年：上限 50000，其他占用 12000，原残余 800，拟改残余 40800，合计 52800，超额 2800 lx·h",
  "details": {
    "adjustmentId": 1,
    "conflicts": {
      "notApproved": false,
      "notStarted": false,
      "outsideMeasurements": [{ "id": 31, "status": "confirmed", "start": "2031-01-02 10:00", "end": "2031-01-02 11:00" }],
      "overlappingPlans": [{ "id": 7, "title": "夜场", "status": "approved", "startDate": "2031-01-01", "endDate": "2031-01-03" }],
      "missingLimits": [],
      "overflows": [{
        "year": 2031, "limit": 50000, "usedByOthers": 12000,
        "oldResidue": 800, "newResidue": 40800, "projected": 52800, "excess": 2800
      }]
    },
    "yearlyReport": { "2031": { "...": "每个相关年份的上限/其他占用/原残余/拟改残余/合计/超额" } }
  }
}
```

常见拒绝：越权（保管员提交、非申请人撤回）→ 403；计划非已批准/已开始/无效时段或照度 → 400；
重复待审申请 → 409（`details.existingAdjustmentId`）。

### 下调年度上限预演 `/api/exhibits/:id/limits/preview`

| 方法 & 路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/exhibits/:id/limits/preview` | 保管员 | 只读预演，不改状态；返回一次性凭证 `previewToken`（30 分钟） |
| `POST /api/exhibits/:id/limits` | 保管员 | 携 `previewToken` 提交：占用变化即拒绝并返回新结果；不携凭证则同事务即时重算 |

预演请求体：

```json
{ "year": 2026, "limitLxh": 500 }
```

预演响应（`preview` 为核算结果，凭证在最外层）：

```json
{
  "previewToken": "a1b2c3…",
  "expiresAt": "2026-09-30T08:30:00.000Z",
  "preview": {
    "exhibitId": 1,
    "year": 2026,
    "currentLimit": 5000,
    "proposedLimit": 500,
    "isLowering": true,
    "used": 2600,
    "projectedExcess": 2100,
    "confirmedMeasurements": [
      { "id": 17, "planId": 12, "start": "2026-03-01 09:00", "end": "2026-03-01 17:00",
        "lux": 150, "yearDose": 1200 }
    ],
    "planResidues": [
      { "id": 12, "title": "三月展", "status": "approved", "residue": 800,
        "firstStart": "2026-03-01 09:00", "notStarted": false },
      { "id": 18, "title": "秋季展", "status": "approved", "residue": 600,
        "firstStart": "2026-10-01 09:00", "notStarted": true }
    ],
    "flagCandidates": [
      { "id": 18, "title": "秋季展", "status": "approved", "residue": 600,
        "firstStart": "2026-10-01 09:00" }
    ],
    "startedStillOver": [
      { "id": 12, "title": "三月展", "status": "approved", "residue": 800,
        "firstStart": "2026-03-01 09:00" }
    ],
    "generatedAt": "2026-09-30T08:00:00.000Z"
  }
}
```

curl 调用示例（预演 → 携凭证提交；预演后占用变化则按返回的新凭证重试）：

```bash
# 1) 保管员预演（不改状态，拿凭证）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits/preview \
  -H 'Content-Type: application/json' \
  -d '{"year":2026,"limitLxh":500}'

# 2) 携凭证提交下调（成功响应=展品详情 + limitChange）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits \
  -H 'Content-Type: application/json' \
  -d '{"year":2026,"limitLxh":500,"previewToken":"<上一步返回的 previewToken>"}'

# 3) 沿用旧字段直接修改（不带凭证；同一事务即时重算）
curl -b cookies-custodian.txt -X POST http://localhost:3000/api/exhibits/1/limits \
  -H 'Content-Type: application/json' \
  -d '{"year":2026,"limitLxh":500}'
```

携凭证提交若凭证失效、字段不一致或预演后额度/占用已变化，返回 **409**：

```json
{
  "error": "预演后 2026 年额度或相关占用已变化，提交被拒绝，请按最新预演结果重新确认",
  "details": {
    "reason": "stale",
    "previewToken": "新凭证…",
    "expiresAt": "…",
    "preview": { "…": "按当前状态重新核算的完整预演结果" }
  }
}
```

`details.reason` 取值：`stale`（占用/额度已变化）、`request_mismatch`（提交字段与预演不一致）、
`token_invalid`（凭证不存在/已过期/已使用）。下调成功响应在原展品详情结构上额外附加：

```json
{
  "exhibit": { "…": "原有字段" },
  "years": { "…": "原有按年额度" },
  "plans": ["…"], "measurements": ["…"], "sources": ["…"],
  "limitChange": {
    "year": 2026, "previousLimit": 5000, "newLimit": 500, "isLowering": true,
    "isUpdate": true, "used": 2600, "projectedExcess": 2100,
    "flagCandidates": [{ "id": 18, "title": "秋季展", "residue": 600, "firstStart": "2026-10-01 09:00" }],
    "startedStillOver": [{ "id": 12, "title": "三月展", "residue": 800, "firstStart": "2026-03-01 09:00", "status": "approved" }],
    "flaggedPlans": [{ "id": 18, "title": "秋季展", "firstStart": "2026-10-01 09:00", "overflowYears": [2026] }]
  }
}
```

页面用法：展品详情「登记/修改年度上限」表单中输入年份与拟定正数上限后，点 **预演下调** 查看只读核算面板
（已确认实测、各计划估算残余、预计超额、将转待复核的未开始计划），再点 **携凭证确认下调**；
也可直接点 **直接保存上限** 走旧路径（同一事务即时重算）。



```
src/
  server.js        启动入口（等待数据库、初始化、起 HTTP 服务）
  app.js           Express 应用与统一错误处理
  config.js        环境变量配置
  db.js            pg 连接池、事务封装、类型解析
  init.js          建表、初始账号、演示数据
  schema.sql       表结构
  auth.js          会话与角色中间件、bcrypt 登录校验
  audit.js         操作流水写入
  limitPreview.js  上限下调预演凭证（一次性、TTL、占用指纹由服务层比对）
  validation.js    中文输入校验（时段/日期/正数等）
  dosing.js        剂量核心算法：时间窗、按年拆分、区间扣除、重叠/包含判断
  service.js       额度占用计算、批准校验、实测窗口校验、待复核筛选、调整申请试算/核对、上限下调预演
  routes/          auth/users/exhibits/plans/adjustments/measurements/audit 路由
public/            原生 HTML/CSS/JS 单页界面
scripts/test-utils.js  核心算法离线测试
Dockerfile / docker-compose.yml
```
