function Component(_options: object): ClassDecorator {
  return () => {};
}

@Component({
  selector: "app-favorite",
  template: `<button (click)="toggle()">♥</button>`,
})
export class FavoriteComponent {
  toggle() {
    return true;
  }
}

@Component({
  selector: "app-article",
  template: `
    <h1>{{ title() }}</h1>
    <app-favorite></app-favorite>
    <a [routerLink]="['/editor', slug]">edit</a>
  `,
})
export class ArticleComponent {
  slug = "x";

  ngOnInit() {
    this.title();
  }

  title() {
    return "Article";
  }
}

export class EditorComponent {}
