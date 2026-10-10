module Admin
  class UsersController < ApplicationController
    def index
      User.all
    end

    def show
      user = User.find(params[:id])
      user.activate!
    end
  end
end
