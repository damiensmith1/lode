class CLI < Thor
  desc "greet NAME", "says hello"
  def greet(name)
    Greeter.new(name).greet
  end
end
