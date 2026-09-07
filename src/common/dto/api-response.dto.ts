export class ApiResponse<T> {
  result: 'success' | 'fail';
  data: T;

  static success<T>(data: T): ApiResponse<T> {
    return {
      result: 'success',
      data,
    };
  }

  static fail(message: string): ApiResponse<string> {
    return {
      result: 'fail',
      data: message,
    };
  }
}
