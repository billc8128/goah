# ADR 0001：里程碑 0 故障语义

- 状态：accepted
- 日期：2026-08-18
- 来源：北辰 Harness 设计稿 v0.10 §5、§8、§10、§11

## 决定

1. 六张主表为 `events` 加五张投影表：`goals`、`schedule`、`wakes`、`mailbox`、`actions`。投影的每次变更都与对应整值事件处于同一个 `BEGIN IMMEDIATE` 事务；投影可从 events 清空重放。
2. `trigger_ref` 在 agent 命名空间内永久去重。同一 agent 只允许一个 `leased` 或 `running` wake。
3. 过期但尚未启动的 `leased` wake 回到 `queued`；过期 `running` wake 先按账本记录的 PID 终止进程组，确认退出后才转 `abnormal` 并保存 salvage ref。每次 lease 带 fencing token，过期 token 的 runner 事件由账本事务拒绝。
4. action 从 `dispatching` 恢复时只转 `unknown`。`unknown` 默认只查询；仅 manifest 同时声明原生幂等与自动重试时，connector 才可重新 dispatch。`reconciled_at` 只在查询之后写入最终 `confirmed`/`failed` 快照。
5. connector manifest 未声明 capability 时挂起，且默认 dry-run。manifest 明确声明 idempotency、query、automatic retry、risk 与参数约束。connector 只通过一次性子进程协议执行，默认不继承 supervisor 环境。
6. handoff reserve 是总 token 上限内的保留额度。进入保留区后 runner 不再执行普通步骤；未产出合法 handoff就记 `abnormal`。生产边界使用可终止子进程；进程内 adapter 仅用于 worker 内部与单元测试。
7. mail 只在合法 handoff 落账时于同一事务 ack；异常 wake 不消费信件。未 ack 的 audit advice 必须进入 action owner 的下次装载。
8. ledger 时钟由构造器注入，action evidence seq 必须真实存在。schema 版本只经显式迁移递增，旧实现拒绝打开未来版本。

## 边界

币种预算窗口聚合、指标采集和 mid-turn compaction 留给后续里程碑；当前实现不引入消息队列、缓存或额外常驻服务。
