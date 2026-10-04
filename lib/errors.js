export class WorkflowError extends Error {
  constructor(message, code, statusCode = 422) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
