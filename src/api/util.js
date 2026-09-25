'use strict';

class ApiError extends Error {
  // extra — подробности для экрана, кроме текста: например, у какого
  // клиента уже записан этот номер, чтобы продавец мог выбрать его сразу.
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { ApiError };
