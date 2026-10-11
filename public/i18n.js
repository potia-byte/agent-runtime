// Presentation-layer translation map for the dashboard UI. It only affects
// how values are displayed in the browser: the API keeps returning the raw
// enum values, and nothing here ever reads or writes the state files.

const STATUS_RU = {
  // Runtime-level status (uppercase)
  RUNNING: "РАБОТАЕТ",
  STOPPED: "ОСТАНОВЛЕН",

  // Provider status (uppercase)
  AVAILABLE: "ДОСТУПЕН",
  BUSY: "ЗАНЯТ",
  QUOTA_LIMITED: "ПАУЗА: ЛИМИТ",
  UNAVAILABLE: "НЕДОСТУПЕН",

  // Task status (lowercase)
  todo: "К ВЫПОЛНЕНИЮ",
  ready: "ГОТОВА К СТАРТУ",
  in_progress: "В РАБОТЕ",
  validating: "ПРОВЕРЯЕТСЯ",
  done: "ГОТОВО",
  blocked: "ЗАБЛОКИРОВАНО",

  // Worker slot status (lowercase)
  starting: "ЗАПУСКАЕТСЯ",
  running: "ВЫПОЛНЯЕТСЯ",
  completed: "ЗАВЕРШЁН",
  failed: "ОШИБКА",
  crashed: "УПАЛ",

  // Worker liveness, as classified by the same predicates recovery uses
  alive: "ЖИВ",
  hung: "ЗАВИС (PID жив, пульса нет)",
  dead: "МЁРТВ",
  finished: "РЕЗУЛЬТАТ ЕСТЬ",
  inactive: "НЕ АКТИВЕН",
};

const UI_RU = {
  statusCard: {
    runtime: "Рантайм",
    pid: "PID",
    started: "Запущен",
    heartbeat: "Обновлено",
    currentTask: "Текущая задача",
    workers: "Воркеров в слотах",
    lastSuccessfulTask: "Последняя успешная задача",
    lastMessage: "Последнее сообщение",
  },
  workers: {
    slot: "Слот",
    worker: "Воркер",
    task: "Задача",
    pid: "PID",
    status: "Статус слота",
    liveness: "Живость",
    heartbeat: "Пульс",
    empty: "нет воркеров в слотах",
  },
  provider: {
    task: "задача",
    quotaReset: "пауза до",
    reason: "причина",
  },
  taskDetail: {
    id: "ID",
    title: "Название",
    description: "Описание",
    status: "Статус",
    priority: "Приоритет",
    agent: "Рекомендованный агент",
    dependsOn: "Зависимости",
    attempts: "Попытки",
    lastError: "Последняя ошибка",
    createdAt: "Создана",
    updatedAt: "Обновлена",
    runs: "Запуски",
  },
  common: {
    none: "нет",
    dash: "—",
  },
  lifecycleActionLabel: {
    start: "запустить",
    stop: "остановить",
  },
  errors: {
    requestFailed: (status) => `Ошибка запроса: ${status}`,
    confirmAction: (action) => `Подтвердите действие «${action}».`,
  },
};

function ru(rawValue) {
  return Object.hasOwn(STATUS_RU, rawValue) ? STATUS_RU[rawValue] : rawValue;
}
