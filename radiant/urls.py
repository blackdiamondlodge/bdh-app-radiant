from django.urls import path

from . import views

urlpatterns = [
    path('', views.radiant_view, name='radiant'),
    path('api/states/', views.radiant_states, name='radiant_states'),
    path('api/history/', views.radiant_history, name='radiant_history'),
    path('api/setpoint/', views.radiant_setpoint, name='radiant_setpoint'),
]
