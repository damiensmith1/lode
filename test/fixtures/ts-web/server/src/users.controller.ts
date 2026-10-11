function Controller(_path: string): ClassDecorator {
  return () => {};
}
function Get(_path?: string): MethodDecorator {
  return () => {};
}

@Controller("accounts")
export class AccountsController {
  @Get(":id")
  find() {
    return "account";
  }
}
