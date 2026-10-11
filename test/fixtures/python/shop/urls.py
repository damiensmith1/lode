from django.urls import path

from . import views

app_name = "shop"

urlpatterns = [
    path("items/<int:pk>/", views.item_detail, name="article-detail"),
]
