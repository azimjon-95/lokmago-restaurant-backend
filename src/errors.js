export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const NotFound = (m = 'Buyurtma topilmadi') => new HttpError(404, m, 'not_found');
export const Conflict = (m = 'Buyurtma allaqachon qabul qilingan') => new HttpError(409, m, 'already_handled');
export const Unauthorized = (m = 'Login yoki parol noto\'g\'ri') => new HttpError(401, m, 'unauthorized');
export const BadRequest = (m) => new HttpError(400, m, 'bad_request');
