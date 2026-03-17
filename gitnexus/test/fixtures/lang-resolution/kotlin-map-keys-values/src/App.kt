fun processValues(data: HashMap<String, User>) {
    for (user in data.values) {
        user.save()
    }
}

fun processList(users: List<User>) {
    for (user in users) {
        user.save()
    }
}
