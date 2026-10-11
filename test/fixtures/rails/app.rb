require "sinatra"

get "/hi" do
  Greeter.build
end
