from django.shortcuts import render
from django.views import View

from .models import Article


def article_list(request):
    return render(request, "blog/article_list.html", {"articles": Article.objects.published()})


class ArticleDetail(View):
    template_name = "blog/_card.html"

    def get(self, request, pk):
        article = Article.objects.get(pk=pk)
        article.publish()
        return article

    def get_context_data(self, **kwargs):
        return kwargs
