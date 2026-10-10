Rails.application.routes.draw do
  root "pages#home"
  resources :posts, only: [:index, :show] do
    member do
      post :publish
    end
    resources :comments, only: [:create]
  end
  namespace :admin do
    resources :users, only: [:index, :show]
  end
  get "/about", to: "pages#about"
end
