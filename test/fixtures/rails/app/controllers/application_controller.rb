class ApplicationController < ActionController::Base
  before_action :authenticate

  def authenticate
    current_user
  end

  def current_user
    @current_user ||= User.find_by(id: session[:uid])
  end
end
